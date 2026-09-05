"""Grommet placement tests — run with `npm run test:python`.

These pin the one thing that is easy to "fix" by accident: legacy draws NO
corner grommet marks. Its addGrommets subtracts the corner set and draws only
what remains, and because getSideGrommetsPositions includes both endpoints of a
side — which are the corners — that removes them from every side as well.

A 2x2 banner therefore comes out with no marks at all. Production has been
receiving files shaped that way for years, so matching it is the requirement.
Anyone who "restores" the corners will fail these tests; that change needs
Linh's confirmation first, not a green light from intuition.

Requires Pillow (src/services/finish/requirements.txt).
"""

import os
import sys
import unittest

from PIL import Image

sys.path.insert(0, os.path.join(
    os.path.dirname(__file__), '..', '..', 'src', 'services', 'finish'))

from grommets import GrommetsAdder  # noqa: E402

ALL_SIDES = ["top", "left", "right", "bottom"]


def drawn_positions(width_px, height_px, width_g, height_g, sides=ALL_SIDES):
    """The marks addGrommets actually draws.

    Runs the real addGrommets and intercepts drawGrommetPoints to capture what
    it was handed. Recomputing the filtering here instead would only test the
    test's own arithmetic — it would pass whatever addGrommets did.
    """
    captured = {}

    class Spy(GrommetsAdder):
        def drawGrommetPoints(self, positions, convertedFileDir):
            captured['positions'] = set(positions)
            return True  # skip the render; we only care which marks were chosen

    adder = Spy()
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "src.tif")
        Image.new("RGB", (width_px, height_px), (255, 255, 255)).save(src)
        adder.addGrommets(
            sides=sides, sourceFileDir=src, convertedFileDir=os.path.join(tmp, "out.tif"),
            widthGrommetsCounts=width_g, heightGrommetsCounts=height_g)
    return captured['positions'], adder


class CornerGrommetsAreNeverDrawn(unittest.TestCase):
    def test_two_by_two_banner_draws_nothing(self):
        # 3ft x 3ft at 72dpi, 2 grommets per side -> every position is a corner.
        drawn, _ = drawn_positions(3 * 12 * 72, 3 * 12 * 72, 2, 2)
        self.assertEqual(len(drawn), 0)

    def test_larger_banner_draws_only_the_intermediate_marks(self):
        # 10ft x 5ft, 5 across and 3 down. Corners are shared between sides:
        # top/bottom contribute 3 intermediates each, left/right 1 each.
        drawn, _ = drawn_positions(10 * 12 * 72, 5 * 12 * 72, 5, 3)
        self.assertEqual(len(drawn), 8)

    def test_no_drawn_mark_sits_on_a_corner(self):
        for w_ft, h_ft, wg, hg in [(3, 3, 2, 2), (10, 5, 5, 3), (6, 4, 4, 3), (2, 8, 2, 4)]:
            with self.subTest(size=f"{w_ft}x{h_ft}"):
                drawn, adder = drawn_positions(w_ft * 12 * 72, h_ft * 12 * 72, wg, hg)
                corners = set(adder.getCornerGrommetPositions())
                self.assertEqual(drawn & corners, set())

    def test_corner_inset_is_54px(self):
        # legacy: 0.75 * 72. Changing it moves every mark.
        self.assertEqual(GrommetsAdder().cornerGrommets, 54)

    def test_requested_sides_are_respected(self):
        # Only top+bottom requested: the left/right intermediates must not appear.
        both, _ = drawn_positions(10 * 12 * 72, 5 * 12 * 72, 5, 3)
        top_bottom, _ = drawn_positions(
            10 * 12 * 72, 5 * 12 * 72, 5, 3, sides=["top", "bottom"])
        self.assertEqual(len(top_bottom), 6)
        self.assertTrue(top_bottom < both)


class GrommetsAreWrittenAt72Dpi(unittest.TestCase):
    def test_output_keeps_72dpi(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "src.tif")
            out = os.path.join(tmp, "out.tif")
            Image.new("RGB", (10 * 12 * 72, 5 * 12 * 72), (255, 255, 255)).save(src)
            GrommetsAdder().addGrommets(
                sides=ALL_SIDES, sourceFileDir=src, convertedFileDir=out,
                widthGrommetsCounts=5, heightGrommetsCounts=3)
            with Image.open(out) as img:
                self.assertEqual(img.info.get("dpi"), (72, 72))


if __name__ == "__main__":
    unittest.main()
