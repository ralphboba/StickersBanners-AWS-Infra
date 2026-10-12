"""Sticker print files (Kai, 2026-10-12) — run with `npm run test:python`.

A round/oval/bumper sticker prints at its real size in inches, at 650 or 1000
dpi, cut to its shape -- what the GA office does in Photoshop (canvas at the
size, ellipse the size of the canvas, art clipped to it). Banners keep 72 dpi.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(
    os.path.dirname(__file__), '..', '..', 'src', 'services', 'resize'))

try:
    from PIL import Image
    import fitz  # noqa: F401
    from converter import pdf_render_dpi, process_image
    from orientation import source_size
    from sticker import (StickerArtNotRound, apply_shape, clip_to_shape, content_box,
                         make_round_sticker, sticker_of, to_print_cmyk)
    HAVE_LIBS = True
except ImportError:  # PIL / PyMuPDF not installed in this interpreter
    HAVE_LIBS = False


class Rect:
    def __init__(self, width_in, height_in):
        self.width = width_in * 72.0
        self.height = height_in * 72.0


@unittest.skipUnless(HAVE_LIBS, 'needs Pillow and PyMuPDF')
class StickerSpec(unittest.TestCase):
    def test_reads_the_intake_spec(self):
        self.assertEqual(sticker_of({'sticker': {'shape': 'circle', 'dpi': 1000}}),
                         {'shape': 'circle', 'dpi': 1000})
        self.assertIsNone(sticker_of({}))
        self.assertIsNone(sticker_of({'sticker': {'shape': 'star', 'dpi': 1000}}))
        self.assertIsNone(sticker_of({'sticker': {'shape': 'oval', 'dpi': 'x'}}))


@unittest.skipUnless(HAVE_LIBS, 'needs Pillow and PyMuPDF')
class Resolution(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def test_raster_prints_at_the_sticker_dpi(self):
        src = os.path.join(self.tmp, 'art.png')
        Image.new('RGB', (300, 300), (200, 30, 30)).save(src)
        out = os.path.join(self.tmp, 'out.tif')
        process_image(src, 2, 2, 'in', out, dpi=1000)
        with Image.open(out) as im:
            self.assertEqual(im.size, (2000, 2000))
            self.assertEqual(round(im.info['dpi'][0]), 1000)

    def test_banners_stay_at_72(self):
        src = os.path.join(self.tmp, 'art.png')
        Image.new('RGB', (300, 200), (0, 0, 255)).save(src)
        out = os.path.join(self.tmp, 'out.tif')
        process_image(src, 3, 2, 'ft', out)
        with Image.open(out) as im:
            self.assertEqual(im.size, (2592, 1728))
            self.assertEqual(round(im.info['dpi'][0]), 72)

    def test_vector_renders_at_least_as_dense_as_the_print(self):
        # A 2x2 in page for a 2x2 in sticker at 1000 dpi: rendering at the
        # banner's 300 would upscale the print 3.3x.
        self.assertEqual(pdf_render_dpi(Rect(2, 2), 2000, 2000), 300)
        self.assertEqual(pdf_render_dpi(Rect(2, 2), 2000, 2000, at_least_output=True), 1000)
        # A page larger than the sticker already renders dense enough.
        self.assertEqual(pdf_render_dpi(Rect(8.5, 11), 2000, 2000, at_least_output=True), 300)

    def test_pdf_sticker_end_to_end(self):
        doc = fitz.open()
        page = doc.new_page(width=144, height=144)  # 2x2 in
        page.draw_rect(page.rect, color=(0, 0, 1), fill=(0, 0, 1))
        src = os.path.join(self.tmp, 'art.pdf')
        doc.save(src)
        out = os.path.join(self.tmp, 'out.tif')
        process_image(src, 2, 2, 'in', out, dpi=1000)
        with Image.open(out) as im:
            self.assertEqual(im.size, (2000, 2000))
            self.assertEqual(round(im.info['dpi'][0]), 1000)


@unittest.skipUnless(HAVE_LIBS, 'needs Pillow and PyMuPDF')
class Shapes(unittest.TestCase):
    def test_circle_keeps_the_middle_and_whitens_the_corners(self):
        im = clip_to_shape(Image.new('RGB', (1000, 1000), (10, 20, 30)), 'circle')
        self.assertEqual(im.getpixel((500, 500)), (10, 20, 30))
        self.assertEqual(im.getpixel((2, 2)), (255, 255, 255))
        self.assertEqual(im.getpixel((997, 997)), (255, 255, 255))
        self.assertEqual(im.getpixel((500, 2)), (10, 20, 30))  # touches the edge

    def test_oval_follows_the_canvas(self):
        im = clip_to_shape(Image.new('RGB', (3000, 2000), (10, 20, 30)), 'oval')
        self.assertEqual(im.getpixel((1500, 5)), (10, 20, 30))
        self.assertEqual(im.getpixel((5, 1000)), (10, 20, 30))
        self.assertEqual(im.getpixel((100, 100)), (255, 255, 255))

    def test_cmyk_white_is_no_ink(self):
        im = clip_to_shape(Image.new('CMYK', (400, 400), (0, 100, 100, 0)), 'circle')
        self.assertEqual(im.mode, 'CMYK')
        self.assertEqual(im.getpixel((1, 1)), (0, 0, 0, 0))

    def test_bumper_stays_a_rectangle(self):
        src = Image.new('RGB', (600, 200), (10, 20, 30))
        self.assertIs(clip_to_shape(src, 'rect'), src)

    def test_apply_shape_makes_the_print_file(self):
        path = os.path.join(tempfile.mkdtemp(), 's.tif')
        Image.new('RGB', (2000, 2000), (10, 20, 30)).save(path, dpi=(1000, 1000), compression='tiff_lzw')
        apply_shape(path, 'circle', 1000)
        with Image.open(path) as im:
            self.assertEqual(round(im.info['dpi'][0]), 1000)
            self.assertEqual(im.mode, 'CMYK')
            self.assertEqual(im.getpixel((0, 0)), (0, 0, 0, 0))  # no ink outside
            self.assertIn(b'SWOP', im.info['icc_profile'])


@unittest.skipUnless(HAVE_LIBS, 'needs Pillow and PyMuPDF')
class Colour(unittest.TestCase):
    """CMYK in U.S. Web Coated (SWOP) v2, as the GA office's Photoshop makes it."""

    def test_rgb_becomes_swop_cmyk_with_the_profile(self):
        cmyk, icc = to_print_cmyk(Image.new('RGB', (4, 4), (255, 255, 255)))
        self.assertEqual(cmyk.mode, 'CMYK')
        self.assertEqual(cmyk.getpixel((0, 0)), (0, 0, 0, 0))  # paper white = no ink
        self.assertIn(b'U.S. Web Coated (SWOP) v2', icc)

    def test_known_colours_land_where_photoshop_puts_them(self):
        # The 2" round S66840's star yellow and ring blue, measured in the
        # office's own SWOP file: rgb (252,175,28) / (104,158,195) after
        # conversion back to sRGB. Ours must come back within a few levels.
        from PIL import ImageCms
        import io
        for rgb in [(251, 175, 27), (107, 159, 195), (4, 51, 86)]:
            cmyk, icc = to_print_cmyk(Image.new('RGB', (1, 1), rgb))
            back = ImageCms.profileToProfile(cmyk, ImageCms.ImageCmsProfile(io.BytesIO(icc)),
                                             ImageCms.createProfile('sRGB'), outputMode='RGB')
            for a, b in zip(back.getpixel((0, 0)), rgb):
                self.assertLessEqual(abs(a - b), 24)

    def test_cmyk_art_keeps_its_numbers(self):
        src = Image.new('CMYK', (2, 2), (0, 100, 100, 0))
        cmyk, _ = to_print_cmyk(src)
        self.assertEqual(cmyk.getpixel((0, 0)), (0, 100, 100, 0))

@unittest.skipUnless(HAVE_LIBS, 'needs Pillow and PyMuPDF')
class RoundFitsTheArt(unittest.TestCase):
    """A round logo in a white margin fills the sticker, as the office does it."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def logo(self, size, box, colour=(200, 30, 30), mode='RGB', bg=(255, 255, 255)):
        im = Image.new(mode, size, bg)
        from PIL import ImageDraw
        ImageDraw.Draw(im).ellipse(box, fill=colour)
        p = os.path.join(self.tmp, 'art.png')
        im.save(p)
        return p

    def test_content_box_ignores_white_and_transparent(self):
        im = Image.new('RGBA', (100, 100), (255, 255, 255, 0))
        im.paste((0, 0, 255, 255), (20, 30, 60, 90))
        self.assertEqual(content_box(im), (20, 30, 60, 90))
        self.assertEqual(content_box(Image.new('RGB', (10, 10), 'white')), (0, 0, 10, 10))

    def test_margin_is_cut_so_the_logo_fills_the_sticker(self):
        # S66381: the logo used 65% of the file; the office's sticker is all logo.
        src = self.logo((1000, 1000), (175, 175, 825, 825))
        out = os.path.join(self.tmp, 'out.tif')
        make_round_sticker(src, 'png', 2, 2, 1000, out, process_image, source_size)
        with Image.open(out) as im:
            self.assertEqual(im.size, (2000, 2000))
            self.assertEqual(round(im.info['dpi'][0]), 1000)
            # The logo now touches the edge midpoints, not 350 px inside them.
            self.assertNotEqual(im.convert('RGB').getpixel((1000, 8)), (255, 255, 255))

    def test_art_that_is_not_round_goes_to_a_person(self):
        # S67093: a phone screenshot, tall, black bars that are not margin.
        src = self.logo((400, 900), (0, 250, 400, 650), bg=(0, 0, 0))
        with self.assertRaises(StickerArtNotRound):
            make_round_sticker(src, 'png', 4, 4, 1000, os.path.join(self.tmp, 'o.tif'), process_image, source_size)


if __name__ == '__main__':
    unittest.main()
