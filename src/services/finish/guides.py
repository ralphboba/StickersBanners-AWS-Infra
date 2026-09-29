"""Proof-viewer guides — where the finishing lands, in the proof's own pixels.

The proof image is the PROCESSED file: the visible face only, before finishing.
The customer sees artwork, but not where the grommet holes go or that a pole
pocket adds a strip that folds behind the banner. This describes those, from
the SAME classes that draw the print file, so the proof page can draw them
without guessing:

  face      the printed face, w x h px at 72 px/in (= the ordered size)
  grommets  every hole, corners included. The print file draws no corner
            marks (see grommets.addGrommets), but the corners are still
            punched, so the customer needs to see them.
  strips    canvas added outside the face by pole pockets / retractable,
            per side, in px. kind "pole-pocket" folds back; "stand-base" is
            the part of a retractable that goes into the stand.
  cropped   RET only: the canvas height is fixed, so artwork taller than it
            is cut. Px lost from the bottom of the face.

Pure: no I/O, no image. Hem is deliberately not described yet.
"""

from grommets import GrommetsAdder
from pole_pockets import PolePocketsAdder

VERSION = 1
DPI = 72


def compute_guides(width, height, finishing_obj, grommet=None, pockets=None):
    grommet = grommet or GrommetsAdder()
    pockets = pockets or PolePocketsAdder()
    guides = {"version": VERSION, "dpi": DPI, "face": {"w": width, "h": height},
              "grommets": [], "strips": []}

    g = finishing_obj.get("grommets")
    if isinstance(g, dict):
        # Grommets are applied to the face before pockets, so these are
        # face coordinates — exactly what the proof image shows.
        grommet.width, grommet.height = width, height
        positions = grommet.getGrommetPositions(
            sides=g.get("sides"),
            widthGrommetsCounts=g.get("widthGrommets", 2),
            heightGrommetsCounts=g.get("heightGrommets", 2))
        guides["grommets"] = sorted([round(x, 1), round(y, 1)] for x, y in positions)

    mode = finishing_obj.get("specialFinishing")
    if mode:
        bg_w, bg_h = pockets.getBackgroundDimensions(mode, width, height)
        ox, oy = pockets.getOffset(mode)
        kind = "stand-base" if mode == "RET" else "pole-pocket"
        depths = {"top": oy, "bottom": bg_h - oy - height,
                  "left": ox, "right": bg_w - ox - width}
        for side, depth in depths.items():
            if depth > 0:
                guides["strips"].append({"side": side, "depth": depth, "kind": kind})
            elif depth < 0:
                guides["cropped"] = {"side": side, "px": -depth}
        guides["mode"] = mode

    return guides
