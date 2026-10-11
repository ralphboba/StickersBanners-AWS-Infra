"""Final print files attached by the office (special instructions, 2026-10-11).

The file goes to the facility exactly as attached: resize only previews it,
finish names it and sends it. These pin the two pure helpers that decide that.
"""

import os
import sys
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "..", "src", "services", "resize"))
from manual import PREVIEW_MAX_PX, is_manual, preview_inches  # noqa: E402

sys.path.insert(0, os.path.join(HERE, "..", "..", "src", "services", "finish"))
from finishing_config import manual_final_name, s3_key_of  # noqa: E402


class Preview(unittest.TestCase):
    def test_only_released_final_jobs_are_manual(self):
        self.assertTrue(is_manual({"manualFiles": True}))
        self.assertFalse(is_manual({"manualFiles": "true"}))
        self.assertFalse(is_manual({}))
        self.assertFalse(is_manual(None))

    def test_small_file_keeps_its_own_size(self):
        self.assertEqual(preview_inches((720, 360), (99, 99)), (10.0, 5.0))

    def test_big_file_is_scaled_down_to_the_cap(self):
        w, h = preview_inches((30000, 15000), (1, 1))
        self.assertAlmostEqual(w * 72, PREVIEW_MAX_PX)
        self.assertAlmostEqual(h * 72, PREVIEW_MAX_PX / 2)

    def test_unreadable_size_falls_back_to_the_order_shape(self):
        self.assertEqual(preview_inches(None, (48, 24)), (48.0, 24.0))


class FinalName(unittest.TestCase):
    def test_order_and_item_lead_their_file_name(self):
        self.assertEqual(manual_final_name("S67674", "2-1", "final.pdf"), "S67674-2-1 final.pdf")

    def test_key_path_is_reduced_to_the_name(self):
        self.assertEqual(manual_final_name("S1", "1-1", "staff/S1/1/123-a.psd"), "S1-1-1 123-a.psd")

    def test_s3_key_of(self):
        self.assertEqual(s3_key_of("s3://bucket/staff/S1/1/1-a.pdf"), "staff/S1/1/1-a.pdf")
        self.assertIsNone(s3_key_of("https://x/a.pdf"))


if __name__ == "__main__":
    unittest.main()
