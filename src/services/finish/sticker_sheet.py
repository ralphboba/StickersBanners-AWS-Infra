"""A sticker's cut sheet as EPS, made next to its TIF -- STICKERS ONLY (Kai,
2026-10-13: "TIF하고 EPS 둘다 되게 해야지. 이건 스티커 제품들만이야").

The GA office puts two files in every sticker order's folder: the sticker
alone (the TIF finish already makes) and an EPS the operator opens in
FineCut to print and cut. This makes that EPS, laid out the way the office
does -- measured from 52 of the office's own files on /GA (2026-10-12) -- with
Kai's decisions where his rule differs from the office's hand work:

- Short side across the roll (the office's rule for every oval and bumper:
  a 3x2 oval stands, 11 a row instead of 7; a 10x3 bumper stands, 7 a row).
- 0.5 in round the stickers and exactly 0.5 in between them (the office's
  gaps wander on big stickers; Kai: "우리는 정확하게 정해서 하자").
- As many a row as fit in 28 in; the row is only as wide as its stickers need
  (3 in rounds: 7 a row, 25 in), as the office does.
- Every row full -- a short last row is filled up (Kai) -- and all the rows in
  one file (Kai), each its own block 0.5 in from the next.
- Each row's four register marks at its corners, the way FineCut draws them:
  spot colour "Mimaki Register Mark" (CMYK 0 0 0 1), 2 pt line, 10 mm arms.
  (FineCut's own tag on the marks lives in Illustrator's private data; not
  written -- Kai, 2026-10-12: "아직 안 해도 될거같아".)
- No printed box and no printed cut line (the office's files have none).
- Bleed: the sticker's edge colour carried 2 pt further out along its shape
  (the office strokes the shape with the edge colour, 4 pt most often), taken
  from 8 px inside the edge so a customer file's pale outermost pixel line
  does not print as a light rim on the cut (S68142's 2x2.jpg has one).

The sticker image is written once (compressed) and drawn at every position.
"""
import base64
import math
import zlib

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

PT = 72.0
SHEET_W_IN = 28.0
MARGIN_IN = 0.5
GAP_IN = 0.5
MARK_ARM_PT = 10 / 25.4 * PT
MARK_PT = 2.0
MARK_COLOUR = "Mimaki Register Mark"
BLEED_PT = 2.0
EDGE_INSET_PX = 8
CHUNK = 60000        # a PostScript string holds at most 65535 bytes
BAND_ROWS = 512      # ellipse bleed is computed this many rows at a time


def sheet_name(tif_name):
    """The EPS's name: the TIF's, as the office pairs them ("S68142 qty 25")."""
    return tif_name[:-4] + ".eps" if tif_name.lower().endswith(".tif") else tif_name + ".eps"


def layout(w_in, h_in, qty):
    """Stickers a row, rows, and the sheet's size, for a sticker w x h placed
    as given (the caller turns it short side across)."""
    cols = max(1, int((SHEET_W_IN - 2 * MARGIN_IN + GAP_IN + 1e-9) // (w_in + GAP_IN)))
    rows = max(1, math.ceil(int(qty or 1) / cols))
    row_w = 2 * MARGIN_IN + cols * w_in + (cols - 1) * GAP_IN
    row_h = 2 * MARGIN_IN + h_in
    return {"cols": cols, "rows": rows, "row_w": row_w, "row_h": row_h,
            "height": rows * row_h + (rows - 1) * GAP_IN}


def bleed_rect(a, pad):
    k = EDGE_INSET_PX
    return np.pad(a[k:-k, k:-k], ((pad + k, pad + k), (pad + k, pad + k), (0, 0)), mode="edge")


def bleed_ellipse(a, pad):
    """The colour just inside the circle/oval carried straight out from the
    centre, `pad` px past the edge; outside that, no ink."""
    h, w = a.shape[:2]
    H, W = h + 2 * pad, w + 2 * pad
    cy, cx = (H - 1) / 2, (W - 1) / 2
    rx, ry = w / 2, h / 2
    inner = 1 - EDGE_INSET_PX / min(rx, ry)
    out = np.zeros((H, W, a.shape[2]), dtype=a.dtype)
    xx = np.arange(W, dtype=np.float32)
    dx = (xx - cx) / rx
    ox = ((xx - cx) / (rx + pad)) ** 2
    for y0 in range(0, H, BAND_ROWS):
        ys = np.arange(y0, min(H, y0 + BAND_ROWS), dtype=np.float32)[:, None]
        dy = (ys - cy) / ry
        rho = np.sqrt(dx * dx + dy * dy)
        scale = np.where(rho > inner, inner / np.maximum(rho, 1e-6), 1.0)
        sx = np.clip(np.rint(cx + dx * scale * rx - pad), 0, w - 1).astype(np.intp)
        sy = np.clip(np.rint(cy + dy * scale * ry - pad), 0, h - 1).astype(np.intp)
        band = a[sy, sx]
        band[(ox + ((ys - cy) / (ry + pad)) ** 2) > 1] = 0
        out[y0:y0 + band.shape[0]] = band
    return out


def _a85_strings(data):
    out = [b"/stkdata ["]
    for i in range(0, len(data), CHUNK):
        out.append(b"<~" + base64.a85encode(data[i:i + CHUNK], wrapcol=255) + b"~>")
    out.append(b"] def\n")
    return b"\n".join(out)


def make_sheet(tif_path, shape, qty, out_path):
    """Write the cut sheet for the sticker in `tif_path` (CMYK, its dpi set,
    already cut to its shape by resize) to `out_path`."""
    with Image.open(tif_path) as im:
        dpi = float(im.info.get("dpi", (72, 72))[0])
        a = np.asarray(im if im.mode == "CMYK" else im.convert("CMYK"))
    w_in, h_in = a.shape[1] / dpi, a.shape[0] / dpi
    standing = w_in > h_in
    if standing:   # short side across the roll
        a = np.rot90(a)
        w_in, h_in = h_in, w_in
    lay = layout(w_in, h_in, qty)
    pad = round(BLEED_PT / PT * dpi)
    a = bleed_ellipse(a, pad) if shape in ("circle", "oval") else bleed_rect(a, pad)
    bleed = pad / dpi * PT
    px_w, px_h = a.shape[1], a.shape[0]
    w, h = px_w / dpi * PT, px_h / dpi * PT        # drawn size, bleed included
    W, H = lay["row_w"] * PT, lay["height"] * PT
    data = zlib.compress(np.ascontiguousarray(a).tobytes(), 6)
    del a

    with open(out_path, "wb") as f:
        f.write(f"""%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 {math.ceil(W)} {math.ceil(H)}
%%HiResBoundingBox: 0 0 {W:.3f} {H:.3f}
%%Title: sticker sheet
%%LanguageLevel: 3
%%DocumentProcessColors: Cyan Magenta Yellow Black
%%DocumentCustomColors: ({MARK_COLOUR})
%%CMYKCustomColor: 0 0 0 1 ({MARK_COLOUR})
%%Pages: 1
%%EndComments
%%BeginProlog
""".encode())
        f.write(_a85_strings(data))
        f.write(f"""/sticker {{
  gsave
  /DeviceCMYK setcolorspace
  {w:.4f} {h:.4f} scale
  /stki 0 def
  << /ImageType 1 /Width {px_w} /Height {px_h} /BitsPerComponent 8
     /Decode [0 1 0 1 0 1 0 1] /ImageMatrix [{px_w} 0 0 -{px_h} 0 {px_h}]
     /DataSource {{ stki stkdata length lt {{ stkdata stki get /stki stki 1 add def }} {{ () }} ifelse }} /FlateDecode filter >> image
  grestore
}} bind def
/markcolour {{ [/Separation ({MARK_COLOUR}) /DeviceCMYK {{ 0 0 0 4 -1 roll }}] setcolorspace 1 setcolor }} bind def
%%EndProlog
%%Page: 1 1
gsave
""".encode())
        row_h = lay["row_h"] * PT
        m, o = MARK_ARM_PT, MARK_PT / 2     # the mark's outer edge on the row's corner
        for r in range(lay["rows"]):
            top = H - r * (row_h + GAP_IN * PT)
            bottom = top - row_h
            for c in range(lay["cols"]):
                x = (MARGIN_IN + c * (w_in + GAP_IN)) * PT
                f.write(f"gsave {x - bleed:.3f} {bottom + MARGIN_IN * PT - bleed:.3f} translate sticker grestore\n".encode())
            f.write(f"gsave markcolour {MARK_PT} setlinewidth 0 setlinecap 0 setlinejoin\n".encode())
            for (x, y, dx, dy) in [(o, bottom + o, 1, 1), (W - o, bottom + o, -1, 1),
                                   (o, top - o, 1, -1), (W - o, top - o, -1, -1)]:
                f.write(f"newpath {x + dx * m:.3f} {y:.3f} moveto {x:.3f} {y:.3f} lineto "
                        f"{x:.3f} {y + dy * m:.3f} lineto stroke\n".encode())
            f.write(b"grestore\n")
        f.write(b"grestore\nshowpage\n%%Trailer\n%%EOF\n")
    return {"cols": lay["cols"], "rows": lay["rows"], "stickers": lay["cols"] * lay["rows"],
            "sheet_in": [round(lay["row_w"], 3), round(lay["height"], 3)], "standing": standing}
