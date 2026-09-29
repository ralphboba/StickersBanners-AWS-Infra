"""Proof-viewer guides — run with `npm run test:python`.

The proof page draws these over the customer's proof, so they have to agree
with the print file to the pixel. Each test builds the real print file with the
finisher's own classes and checks the guides against what came out.
"""

import os
import sys
import tempfile
import unittest

from PIL import Image

sys.path.insert(0, os.path.join(
    os.path.dirname(__file__), '..', '..', 'src', 'services', 'finish'))

from grommets import GrommetsAdder  # noqa: E402
from guides import compute_guides  # noqa: E402
from pole_pockets import PolePocketsAdder  # noqa: E402

ALL = ["top", "left", "right", "bottom"]


def printed(mode, w, h):
    """Size of the finished print file and where the face sits in it."""
    with tempfile.TemporaryDirectory() as d:
        src, out = os.path.join(d, "a.tif"), os.path.join(d, "b.tif")
        Image.new("RGB", (w, h), (255, 0, 0)).save(src)
        PolePocketsAdder().addPolePockets(mode=mode, sourceFileDir=src, convertedFileDir=out)
        with Image.open(out) as img:
            # The face is the red block (the fold line is black, the pocket
            # white): scan through its middle for where it starts.
            img = img.convert("RGB")
            px = img.load()
            left = next(x for x in range(img.width) if px[x, img.height // 2] == (255, 0, 0))
            top = next(y for y in range(img.height) if px[img.width // 2, y] == (255, 0, 0))
            return img.size, (left, top)


class GuidesTest(unittest.TestCase):
    def test_no_finishing_is_just_the_face(self):
        g = compute_guides(2592, 1728, {"quantity": 1})
        self.assertEqual(g["face"], {"w": 2592, "h": 1728})
        self.assertEqual(g["grommets"], [])
        self.assertEqual(g["strips"], [])
        self.assertEqual(g["dpi"], 72)

    def test_grommets_include_the_corners(self):
        # The print file draws no corner marks, but the corners are punched.
        g = compute_guides(432, 288, {"grommets": {"sides": ALL}})
        self.assertEqual(g["grommets"], [[54, 54], [54, 234], [378, 54], [378, 234]])

    def test_grommets_match_the_finisher_positions(self):
        fin = {"grommets": {"sides": ALL, "widthGrommets": 5, "heightGrommets": 3}}
        g = compute_guides(4320, 2160, fin)
        ref = GrommetsAdder()
        ref.width, ref.height = 4320, 2160
        want = sorted([round(x, 1), round(y, 1)] for x, y in ref.getGrommetPositions(ALL, 5, 3))
        self.assertEqual(g["grommets"], want)
        self.assertEqual(len(g["grommets"]), 12)

    def test_strips_match_the_print_file_for_every_mode(self):
        w, h = 360, 504
        for mode in ["PPTB", "PPTO", "PPBO", "PPL", "PPR", "PPS"]:
            with self.subTest(mode=mode):
                g = compute_guides(w, h, {"specialFinishing": mode})
                (pw, ph), (fx, fy) = printed(mode, w, h)
                s = {st["side"]: st["depth"] for st in g["strips"]}
                self.assertEqual(s.get("left", 0), fx)
                self.assertEqual(s.get("top", 0), fy)
                self.assertEqual(s.get("right", 0), pw - fx - w)
                self.assertEqual(s.get("bottom", 0), ph - fy - h)
                self.assertTrue(all(st["kind"] == "pole-pocket" for st in g["strips"]))
                self.assertTrue(all(st["depth"] == 324 for st in g["strips"]))  # 4.5 in
                self.assertNotIn("cropped", g)

    def test_retractable_stand_base(self):
        g = compute_guides(33 * 72, 80 * 72, {"specialFinishing": "RET"})
        self.assertEqual(g["strips"], [{"side": "bottom", "depth": 216, "kind": "stand-base"}])
        self.assertNotIn("cropped", g)

    def test_retractable_taller_than_the_stand_is_cropped(self):
        # Canvas is fixed at 83 in; a 90 in upload loses its bottom 7 in.
        g = compute_guides(33 * 72, 90 * 72, {"specialFinishing": "RET"})
        self.assertEqual(g["strips"], [])
        self.assertEqual(g["cropped"], {"side": "bottom", "px": 7 * 72})

    def test_grommets_and_pockets_together(self):
        fin = {"grommets": {"sides": ["left", "right"]}, "specialFinishing": "PPTB"}
        g = compute_guides(720, 1440, fin)
        self.assertEqual(len(g["grommets"]), 4)
        self.assertEqual({st["side"] for st in g["strips"]}, {"top", "bottom"})


if __name__ == "__main__":
    unittest.main()
