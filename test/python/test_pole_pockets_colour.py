"""Pole pockets must not change the artwork's colour space.

Linh's reference RET file is CMYK. Ours was RGB, because the canvas was built
with Image.new("RGB", ...) and Image.paste converts the artwork to the canvas
mode on the way in. A press handed RGB where it expected CMYK applies a colour
conversion nobody asked for, and the printed piece stops matching the proof the
customer approved.

The obvious fix is a trap, which is why these tests exist: PIL will happily
resolve "white" in CMYK to (255, 255, 255, 255) -- full ink on every plate,
i.e. solid black. Getting the mode right while getting the fill wrong turns a
colour shift into a black band across the pole pocket, which is much worse.

Geometry numbers below are read off Linh's own sample files:
    RET   2268 x 5976  CMYK   artwork 5760 px + exactly 216 px of white
    PPTO  6624 x 6948  RGB    exactly 324 px of white above the artwork
"""

import os
import sys
import tempfile
import unittest

from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "services", "finish"))

from pole_pockets import PolePocketsAdder, canvas_colour  # noqa: E402

Image.MAX_IMAGE_PIXELS = None


def finish(mode, size, pocket_mode, source_pixel):
    """Run one file through the finisher and hand back the result to inspect."""
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "src.tif")
        out = os.path.join(d, "out.tif")
        Image.new(mode, size, source_pixel).save(src, compression="tiff_lzw")
        PolePocketsAdder().addPolePockets(
            mode=pocket_mode, sourceFileDir=src, convertedFileDir=out)
        with Image.open(out) as im:
            return im.mode, im.size, im.copy()


class TestColourNames(unittest.TestCase):
    def test_cmyk_white_is_no_ink(self):
        # (255, 255, 255, 255) would be solid black. This is the whole reason
        # the module carries its own table instead of calling ImageColor.
        self.assertEqual(canvas_colour("CMYK", "white"), (0, 0, 0, 0))
        self.assertEqual(canvas_colour("CMYK", "black"), (0, 0, 0, 255))

    def test_unmapped_mode_returns_none(self):
        # The caller falls back to RGB rather than inventing an ink value.
        self.assertIsNone(canvas_colour("RGBA", "white"))
        self.assertIsNone(canvas_colour("RGB", "chartreuse"))


class TestRetractable(unittest.TestCase):
    def test_cmyk_artwork_stays_cmyk(self):
        mode, size, im = finish("CMYK", (2268, 5760), "RET", (0, 0, 0, 30))
        self.assertEqual(mode, "CMYK")
        self.assertEqual(size, (2268, 5976))  # 80in*72 + 3in*72, as Linh's file

    def test_cmyk_filler_band_is_actually_white(self):
        _, size, im = finish("CMYK", (2268, 5760), "RET", (0, 0, 0, 30))
        # Sample inside the 216 px band below the artwork.
        px = im.getpixel((size[0] // 2, size[1] - 5))
        self.assertEqual(px, (0, 0, 0, 0))
        self.assertEqual(im.convert("RGB").getpixel((size[0] // 2, size[1] - 5)),
                         (255, 255, 255))


class TestNoRegressionForRgb(unittest.TestCase):
    """The 99% case has to come out exactly as it did before the fix."""

    def test_rgb_pole_pocket_unchanged(self):
        mode, size, im = finish("RGB", (6624, 6624), "PPTO", (10, 20, 30))
        self.assertEqual(mode, "RGB")
        self.assertEqual(size, (6624, 6948))  # +324, as Linh's PPTO sample
        self.assertEqual(im.getpixel((size[0] // 2, 5)), (255, 255, 255))

    def test_rgb_artwork_lands_below_the_pocket(self):
        _, size, im = finish("RGB", (6624, 6624), "PPTO", (10, 20, 30))
        # Linh's sample has artwork starting at exactly y=324.
        self.assertEqual(im.getpixel((size[0] // 2, 324)), (10, 20, 30))


if __name__ == "__main__":
    unittest.main()
