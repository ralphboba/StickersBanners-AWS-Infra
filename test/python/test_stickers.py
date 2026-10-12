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
    from sticker import apply_shape, clip_to_shape, sticker_of
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

    def test_apply_shape_keeps_the_dpi(self):
        path = os.path.join(tempfile.mkdtemp(), 's.tif')
        Image.new('RGB', (2000, 2000), (10, 20, 30)).save(path, dpi=(1000, 1000), compression='tiff_lzw')
        apply_shape(path, 'circle', 1000)
        with Image.open(path) as im:
            self.assertEqual(round(im.info['dpi'][0]), 1000)
            self.assertEqual(im.getpixel((0, 0)), (255, 255, 255))


if __name__ == '__main__':
    unittest.main()
