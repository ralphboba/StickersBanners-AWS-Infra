"""pixmap_to_image must be the PNG round trip it replaced — `npm run test:python`.

_convert_pdf used to hand PIL the rendered page as PNG bytes:

    Image.open(io.BytesIO(pix.tobytes("png")))

PNG is lossless, so that produced exactly the raster PyMuPDF had already
rasterised — after paying for an encode, a decode, and two more full-size
copies alive at the same time, on precisely the files that are already too big
to hold twice (see test_pdf_render.py for the S61866 OOM).

Reading pix.samples skips all of it. That is only safe if the pixels are the
same ones, and our print files are byte-identical to Linh's today, so "the same
ones" is not a detail. This builds a real pixmap and compares.

Needs PyMuPDF and Pillow; skipped where the resize container's deps are absent,
because the module under test cannot even be imported without them.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(
    os.path.dirname(__file__), '..', '..', 'src', 'services', 'resize'))

try:
    import io as _io

    import fitz
    from PIL import Image
    DEPS = None
except Exception as err:  # pragma: no cover - depends on the environment
    DEPS = str(err)


def _load_pixmap_to_image():
    """Pull the one function out of converter.py without importing psd_tools."""
    path = os.path.join(os.path.dirname(__file__), '..', '..',
                        'src', 'services', 'resize', 'converter.py')
    with open(path, encoding='utf-8') as fh:
        source = fh.read()
    start = source.index('def pixmap_to_image')
    end = source.index('def _convert_pdf')
    namespace = {'Image': Image, 'io': _io}
    exec(compile(source[start:end], path, 'exec'), namespace)  # noqa: S102
    return namespace['pixmap_to_image']


@unittest.skipIf(DEPS, f'PyMuPDF/Pillow unavailable: {DEPS}')
class SameRasterEitherWay(unittest.TestCase):
    """A synthetic page, rendered at several densities, both ways."""

    @classmethod
    def setUpClass(cls):
        cls.pixmap_to_image = staticmethod(_load_pixmap_to_image())
        doc = fitz.open()
        page = doc.new_page(width=612, height=792)
        # Colour, so a channel swap or a stride bug cannot pass unnoticed the
        # way it would on a blank white page.
        page.draw_rect(fitz.Rect(40, 40, 400, 300), color=(1, 0, 0), fill=(0, 0, 1))
        page.draw_circle(fitz.Point(300, 500), 120, color=(0, 1, 0), fill=(1, 1, 0))
        page.insert_text(fitz.Point(60, 700), 'S61866', fontsize=48)
        cls.page = page
        cls.doc = doc

    @classmethod
    def tearDownClass(cls):
        cls.doc.close()

    def _both(self, dpi):
        pix = self.page.get_pixmap(dpi=dpi)
        old = Image.open(_io.BytesIO(pix.tobytes('png')))
        new = type(self).pixmap_to_image(pix)
        return pix, old, new

    def test_pixels_are_identical(self):
        for dpi in (36, 72, 150, 300):
            with self.subTest(dpi=dpi):
                _, old, new = self._both(dpi)
                self.assertEqual(old.size, new.size)
                self.assertEqual(old.mode, new.mode)
                self.assertEqual(old.convert('RGBA').tobytes(),
                                 new.convert('RGBA').tobytes())

    def test_mode_follows_the_pixmap_alpha(self):
        pix, _, new = self._both(72)
        self.assertEqual(new.mode, 'RGBA' if pix.alpha else 'RGB')

    def test_an_alpha_pixmap_still_matches_the_png(self):
        # The one case where samples and PNG are NOT interchangeable: PyMuPDF
        # premultiplies alpha and the PNG encoder does not, so frombytes on
        # pix.samples would darken every partly transparent pixel towards its
        # own alpha. Writing this test is how that was found. _convert_pdf never
        # requests alpha, but the helper must not be wrong for whoever does.
        pix = self.page.get_pixmap(dpi=72, alpha=True)
        self.assertTrue(pix.alpha)
        new = type(self).pixmap_to_image(pix)
        self.assertEqual(new.mode, 'RGBA')
        self.assertEqual(
            Image.open(_io.BytesIO(pix.tobytes('png'))).convert('RGBA').tobytes(),
            new.convert('RGBA').tobytes())

    def test_premultiplied_samples_would_have_been_wrong(self):
        # Guards the comment above: if a PyMuPDF release ever stops
        # premultiplying, the branch is dead weight and should be removed.
        pix = self.page.get_pixmap(dpi=72, alpha=True)
        naive = Image.frombytes('RGBA', (pix.width, pix.height), pix.samples)
        self.assertNotEqual(
            Image.open(_io.BytesIO(pix.tobytes('png'))).convert('RGBA').tobytes(),
            naive.tobytes(),
            'pix.samples matched the PNG — the alpha branch may no longer be needed')


if __name__ == '__main__':
    unittest.main()
