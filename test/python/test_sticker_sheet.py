"""Sticker cut sheet EPS (finish/sticker_sheet.py) -- run with `npm run test:python`.

Layouts are the GA office's, measured from its own FineCut files on /GA
(2026-10-12); spacing is Kai's exact 0.5 in.
"""
import os
import re
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'services', 'finish'))

try:
    import numpy as np
    from PIL import Image
    from sticker_sheet import (bleed_ellipse, bleed_rect, layout, make_sheet, sheet_name)
    HAVE_LIBS = True
except ImportError:  # numpy / Pillow not installed in this interpreter
    HAVE_LIBS = False


@unittest.skipUnless(HAVE_LIBS, 'needs numpy and Pillow')
class Layout(unittest.TestCase):
    def test_rows_as_the_office_lays_them(self):
        # (sticker across x along the roll) -> (a row, row width in) -- office files
        for (w, h), (cols, row_w) in {
            (2, 2): (11, 28.0),     # S68142, S64925 ...
            (3, 3): (7, 25.0),      # S66381, S65028 ...
            (4, 4): (6, 27.5),      # S67093, S65004 ...
            (5, 5): (5, 28.0),      # S65535 (1)
            (2, 3): (11, 28.0),     # 3x2 oval standing, S64927 / S66797
            (3, 10): (7, 25.0),     # 10x3 bumper standing, S64820
            (4, 12): (6, 27.5),     # 12x4 bumper standing, S66112
            (12, 12): (2, 25.5),    # S66935 (1): 2 a row; the office's wider gap was by hand
        }.items():
            lay = layout(w, h, 25)
            self.assertEqual((lay['cols'], lay['row_w']), (cols, row_w), (w, h))

    def test_short_last_row_is_filled(self):
        lay = layout(2, 2, 25)  # 11 a row: 3 rows, 33 stickers
        self.assertEqual((lay['rows'], lay['cols'] * lay['rows']), (3, 33))
        self.assertEqual(lay['height'], 3 * 3 + 2 * 0.5)

    def test_name_pairs_with_the_tif(self):
        self.assertEqual(sheet_name('S68142 qty 25.tif'), 'S68142 qty 25.eps')
        self.assertEqual(sheet_name('S68045 - (1) qty 25.tif'), 'S68045 - (1) qty 25.eps')


@unittest.skipUnless(HAVE_LIBS, 'needs numpy and Pillow')
class Bleed(unittest.TestCase):
    def test_rect_carries_the_edge_out_and_covers_a_pale_rim(self):
        a = np.full((100, 100, 4), 200, np.uint8)
        a[0, :] = 30                          # a pale outermost line, as in S68142's art
        out = bleed_rect(a, 5)
        self.assertEqual(out.shape, (110, 110, 4))
        self.assertTrue((out[:10, :] == 200).all())   # bleed and the old rim are the art's colour

    def test_ellipse_bleeds_round_the_shape_and_no_ink_beyond(self):
        a = np.zeros((200, 200, 4), np.uint8)
        yy, xx = np.mgrid[0:200, 0:200]
        a[(xx - 99.5) ** 2 + (yy - 99.5) ** 2 <= 100 ** 2] = (0, 90, 90, 0)
        out = bleed_ellipse(a, 6)
        self.assertEqual(out.shape, (212, 212, 4))
        self.assertEqual(tuple(out[3, 105]), (0, 90, 90, 0))   # 3 px outside the circle: bleed
        self.assertEqual(tuple(out[1, 1]), (0, 0, 0, 0))       # corner: no ink


@unittest.skipUnless(HAVE_LIBS, 'needs numpy and Pillow')
class Eps(unittest.TestCase):
    def sheet(self, size_px, dpi, shape, qty):
        d = tempfile.mkdtemp()
        tif = os.path.join(d, 's.tif')
        Image.new('CMYK', size_px, (10, 80, 80, 5)).save(tif, dpi=(dpi, dpi))
        out = os.path.join(d, 's.eps')
        info = make_sheet(tif, shape, qty, out)
        with open(out, 'rb') as f:
            return info, f.read()

    def test_mimaki_marks_on_every_row_and_no_lines(self):
        info, eps = self.sheet((200, 200), 100, 'rect', 25)    # 2x2 in
        self.assertEqual((info['cols'], info['rows'], info['sheet_in']), (11, 3, [28.0, 10.0]))
        self.assertIn(b'%%BoundingBox: 0 0 2016 720', eps)
        self.assertIn(b'%%CMYKCustomColor: 0 0 0 1 (Mimaki Register Mark)', eps)
        self.assertEqual(eps.count(b'markcolour 2.0 setlinewidth'), 3)    # one set of marks a row
        self.assertEqual(len(re.findall(rb'lineto stroke', eps)), 12)      # 4 marks x 3 rows, nothing else
        self.assertEqual(eps.count(b'translate sticker'), 33)
        self.assertEqual(eps.count(b'/stkdata ['), 1)                      # the image is written once

    def test_an_oval_stands(self):
        info, _ = self.sheet((300, 200), 100, 'oval', 350)    # 3x2 in
        self.assertTrue(info['standing'])
        self.assertEqual((info['cols'], info['sheet_in'][0]), (11, 28.0))


if __name__ == '__main__':
    unittest.main()
