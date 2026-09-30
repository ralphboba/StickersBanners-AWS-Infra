"""Is the customer's file the other way round from what they ordered?

Warehouse, 2026-09-29 (Danny): a customer uploads an 8x3 ft design but picks
3x8 on the website, and it prints 3x8 -- the artwork stretched to fit. Both
programs print what was ordered; neither checks the file. The warehouse catches
the obvious ones (3x8) by eye and misses the subtle ones (6x4, 5x4). The daily
census counted 16-18 such orders a day (2026-09-23, 2026-09-25).

This only answers the question. What to do about it -- hold the order so a
person picks "swap" or "as ordered" -- is main.py's business.

Import-light on purpose (no boto3), so it unit-tests without the image stack.
"""

import math

# Anything within 5% of square is "square": a 1.03 file on a 0.97 order is not
# a customer who picked the wrong way round, and flagging it would train staff
# to click through the warning.
SQUARE_TOLERANCE = 0.05


def _orientation(w, h, tol=SQUARE_TOLERANCE):
    """'landscape', 'portrait' or 'square'."""
    ratio = w / h
    if abs(math.log(ratio)) <= math.log(1 + tol):
        return "square"
    return "landscape" if ratio > 1 else "portrait"


def orientation_mismatch(src_w, src_h, out_w, out_h, tol=SQUARE_TOLERANCE):
    """None, or why this file looks swapped against the ordered size.

    Swapped means the file is landscape and the order portrait, or the reverse,
    both clearly so. When that holds, the swapped order always fits the file
    better than the one placed -- so "the other way round" is the whole test.
    """
    if not (src_w and src_h and out_w and out_h):
        return None
    src = _orientation(src_w, src_h, tol)
    out = _orientation(out_w, out_h, tol)
    if "square" in (src, out) or src == out:
        return None
    as_ordered = abs(math.log((src_w / src_h) / (out_w / out_h)))
    swapped = abs(math.log((src_w / src_h) * (out_w / out_h)))
    return {
        "file": src,
        "ordered": out,
        # How far the artwork is stretched either way, as a factor (1.0 = none).
        "stretchAsOrdered": round(math.exp(as_ordered), 2),
        "stretchIfSwapped": round(math.exp(swapped), 2),
    }


def source_size(path, ext):
    """The file's own width x height, in whatever units, or None.

    Only the aspect is used, so a PDF page in points is as good as pixels. The
    orientation is the one resize will PRINT: raw pixels for rasters (legacy
    never applies EXIF rotation), and the trimbox for PDFs (what legacy crops
    to), with the page's own /Rotate applied as rendering does.
    """
    ext = (ext or "").lower()
    try:
        if ext in ("pdf", "ai"):
            with open(path, "rb") as f:
                if not f.read(5).startswith(b"%PDF"):
                    return None  # PostScript .ai: rendered by gs, not sized here
            import fitz  # PyMuPDF, only needed for this branch
            doc = fitz.open(path)
            try:
                page = doc[0]
                page.set_cropbox(page.trimbox)
                return page.rect.width, page.rect.height
            finally:
                doc.close()
        if ext == "psd":
            from psd_tools import PSDImage
            psd = PSDImage.open(path)
            return psd.width, psd.height
        from PIL import Image
        with Image.open(path) as img:  # header only; pixels are not decoded
            return img.size
    except Exception as exc:  # a file we cannot size is not a swapped file
        print(f"orientation: could not size {path}: {exc}")
        return None
