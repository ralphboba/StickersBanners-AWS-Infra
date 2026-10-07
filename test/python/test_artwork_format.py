"""The bytes decide the format, not the name -- `npm run test:python`.

S64856 (2026-09-30) was a 519 MB Photoshop document named Backdrop.pdf; it
failed four times in the PDF path. S65512 (2026-10-02) was a real .psd that
psd-tools 1.10.8 could not parse. Both are pinned here.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..',
                                'src', 'services', 'resize'))

from artwork import corrected_extension, sniff_format  # noqa: E402


def write(d, name, head):
    p = os.path.join(d, name)
    with open(p, 'wb') as f:
        f.write(head + b'\0' * 64)
    return p


class Sniff(unittest.TestCase):
    def test_signatures(self):
        with tempfile.TemporaryDirectory() as d:
            cases = {b'%PDF-1.4': 'pdf', b'8BPS\x00\x01': 'psd',
                     b'\x89PNG\r\n\x1a\n': 'png', b'\xff\xd8\xff\xe0': 'jpg',
                     b'II*\x00': 'tif', b'MM\x00*': 'tif', b'%!PS-Adobe': 'ps', b'\xc5\xd0\xd3\xc6': 'ps',
                     b'\x00\x00\x00\x0cjP  \r\n\x87\n': 'jp2', b'\xff\x4f\xff\x51': 'jp2',
                     b'random bytes': None}
            for head, want in cases.items():
                self.assertEqual(sniff_format(write(d, 'f', head)), want, head)


class Corrected(unittest.TestCase):
    def test_photoshop_named_pdf_goes_down_the_psd_path(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(corrected_extension('pdf', write(d, 'Backdrop.pdf', b'8BPS')), 'psd')

    def test_same_route_keeps_its_name(self):
        # Nothing that converts today may be routed differently tomorrow.
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(corrected_extension('jpeg', write(d, 'a', b'\xff\xd8\xff')), 'jpeg')
            self.assertEqual(corrected_extension('tiff', write(d, 'a', b'II*\x00')), 'tiff')
            self.assertEqual(corrected_extension('ai', write(d, 'a', b'%PDF-1.6')), 'ai')
            self.assertEqual(corrected_extension('psd', write(d, 'a', b'8BPS')), 'psd')
            # Added to the allow list 2026-10-07: same raster route, names kept.
            self.assertEqual(corrected_extension('jfif', write(d, 'a', b'\xff\xd8\xff')), 'jfif')
            self.assertEqual(corrected_extension('jpf', write(d, 'a', b'\x00\x00\x00\x0cjP  \r\n\x87\n')), 'jpf')

    def test_unknown_bytes_keep_the_name(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(corrected_extension('pdf', write(d, 'a', b'??')), 'pdf')

    def test_cross_route_mismatches(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(corrected_extension('png', write(d, 'a', b'%PDF-1.4')), 'pdf')
            self.assertEqual(corrected_extension('pdf', write(d, 'a', b'\x89PNG\r\n\x1a\n')), 'png')
            self.assertEqual(corrected_extension('pdf', write(d, 'a', b'%!PS-Adobe')), 'eps')
            # Illustrator/Photoshop "EPS with preview" binary header.
            self.assertEqual(corrected_extension('pdf', write(d, 'a', b'\xc5\xd0\xd3\xc6')), 'eps')
            self.assertEqual(corrected_extension('eps', write(d, 'a', b'\xc5\xd0\xd3\xc6')), 'eps')


class NewRasterFormats(unittest.TestCase):
    """jfif, jp2, jpf (Kai, 2026-10-07): converted like any raster file."""

    def test_each_converts_to_a_print_file(self):
        from PIL import Image
        from converter import process_image
        with tempfile.TemporaryDirectory() as d:
            src = Image.new('RGB', (300, 200), (200, 30, 30))
            for ext, fmt in (('jfif', 'JPEG'), ('jp2', 'JPEG2000'), ('jpf', 'JPEG2000')):
                path, out = os.path.join(d, f'a.{ext}'), os.path.join(d, f'{ext}.tif')
                src.save(path, fmt)
                self.assertTrue(process_image(path, 3, 2, 'in', out), ext)
                with Image.open(out) as im:
                    self.assertEqual(im.size, (216, 144), ext)


class TiffPillowCannotOpen(unittest.TestCase):
    """CMYK + alpha (5 samples): five real uploads 2026-09-10 that Pillow, and
    so Linh's program, could not open. Read with tifffile, alpha onto white."""

    def test_cmyk_with_alpha_becomes_a_cmyk_print_file(self):
        try:
            import numpy as np
            import tifffile
        except ImportError:
            self.skipTest('tifffile not installed')
        from PIL import Image
        from converter import process_image
        with tempfile.TemporaryDirectory() as d:
            arr = np.zeros((40, 60, 5), np.uint8)
            arr[:, :, 0] = 200          # cyan ink everywhere
            arr[:, :30, 4] = 255         # left half opaque
            arr[:, 30:, 4] = 0           # right half transparent
            src, out = os.path.join(d, 'a.tiff'), os.path.join(d, 'o.tif')
            tifffile.imwrite(src, arr, photometric='separated', extrasamples=['unassalpha'])
            with self.assertRaises(Exception):
                Image.open(src)  # the case this exists for
            self.assertTrue(process_image(src, 2, 1, 'in', out))
            with Image.open(out) as im:
                self.assertEqual(im.mode, 'CMYK')
                left, right = im.getpixel((10, im.height // 2)), im.getpixel((im.width - 10, im.height // 2))
                self.assertGreater(left[0], 150)   # ink kept where opaque
                self.assertEqual(right, (0, 0, 0, 0))  # white where transparent


class PsdFallback(unittest.TestCase):
    def test_a_psd_psd_tools_rejects_falls_back_to_its_stored_composite(self):
        try:
            import converter
            from PIL import Image
        except Exception as exc:  # image stack not installed here
            self.skipTest(str(exc))
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, 'a.psd')
            Image.new('RGB', (40, 20), (200, 10, 10)).save(os.path.join(d, 'a.png'))
            # A PSD PIL can read but psd-tools is told to reject.
            open(src, 'wb').write(b'not used')
            out = os.path.join(d, 'o.tif')

            class Boom:
                @staticmethod
                def open(_):
                    raise AssertionError('Invalid version 8')
            real_psd, real_open = converter.PSDImage, converter.Image.open
            converter.PSDImage = Boom
            converter.Image.open = lambda p, *a, **k: real_open(os.path.join(d, 'a.png'))
            try:
                converter._convert_psd(src, 80, 40, out)
            finally:
                converter.PSDImage, converter.Image.open = real_psd, real_open
            self.assertEqual(Image.open(out).size, (80, 40))


if __name__ == '__main__':
    unittest.main()
