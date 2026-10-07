"""File the other way round from the order — `npm run test:python`.

Warehouse (Danny, 2026-09-29): a customer uploads an 8x3 design, picks 3x8 on
the site, and it prints 3x8 with the artwork stretched. Resize now stops those
for a person. The cases below are real orders from the 2026-09-23 / 09-25
census, with the sizes the census recorded.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..',
                                'src', 'services', 'resize'))

from orientation import orientation_mismatch, source_size  # noqa: E402

IN = 72


class RealOrders(unittest.TestCase):
    def test_flagged(self):
        cases = [
            # order, file size, what the census saw
            ("S63735", (46 * IN, 72 * IN), (4320, 3444)),      # portrait order, landscape file
            ("S62895", (24 * IN, 120 * IN), (6250, 1250)),     # stretched 25x as ordered
            ("S62951", (60 * IN, 72 * IN), (2000, 1600)),      # an exact swap
            ("S63074", (96 * IN, 72 * IN), (1290, 1931)),      # landscape order, portrait file
            ("S63491", (24 * IN, 48 * IN), (1774, 887)),       # 10 items like this one
        ]
        for order, (ow, oh), (fw, fh) in cases:
            with self.subTest(order=order):
                m = orientation_mismatch(fw, fh, ow, oh)
                self.assertIsNotNone(m, order)
                self.assertGreater(m["stretchAsOrdered"], m["stretchIfSwapped"])

    def test_not_flagged(self):
        cases = [
            ("S63736 square both", (92 * IN, 92 * IN), (3919, 3919)),
            ("same way round, just a different ratio", (72 * IN, 24 * IN), (1536, 1024)),
            ("square order, any file", (72 * IN, 72 * IN), (1024, 1536)),
            ("near-square file", (46 * IN, 72 * IN), (1030, 1000)),
        ]
        for label, (ow, oh), (fw, fh) in cases:
            with self.subTest(label):
                self.assertIsNone(orientation_mismatch(fw, fh, ow, oh))

    def test_missing_numbers_are_not_a_mismatch(self):
        self.assertIsNone(orientation_mismatch(None, 100, 10, 20))
        self.assertIsNone(orientation_mismatch(100, 50, 0, 20))


class SourceSize(unittest.TestCase):
    def test_raster_uses_raw_pixels(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.png")
            Image.new("RGB", (300, 100)).save(p)
            self.assertEqual(source_size(p, "png"), (300, 100))

    def test_pdf_uses_the_trimbox_like_the_render_does(self):
        import fitz
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.pdf")
            doc = fitz.open()
            page = doc.new_page(width=800, height=400)
            page.set_trimbox(fitz.Rect(0, 0, 200, 400))  # portrait inside a landscape page
            doc.save(p)
            w, h = source_size(p, "pdf")
            self.assertLess(w, h)

    def test_unreadable_file_is_none(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.png")
            open(p, "wb").write(b"not an image")
            self.assertIsNone(source_size(p, "png"))




class SwapActionTest(unittest.TestCase):
    """Kai, 2026-10-07: proof orders go to Proofing as usual; only no-proof
    orders stop for a person (Size Check)."""

    def setUp(self):
        from orientation import swap_action
        self.swap_action = swap_action
        self.swapped = [{"itemNo": 1, "ordered": "6 x 8 ft", "swapped": "8 x 6 ft"}]

    def test_nothing_swapped_does_nothing(self):
        self.assertIsNone(self.swap_action(True, []))
        self.assertIsNone(self.swap_action(False, []))

    def test_proof_order_is_noted_not_held(self):
        self.assertEqual(self.swap_action(True, self.swapped), "note")

    def test_no_proof_order_is_held(self):
        self.assertEqual(self.swap_action(False, self.swapped), "hold")


if __name__ == "__main__":
    unittest.main()
