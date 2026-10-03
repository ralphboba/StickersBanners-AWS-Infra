"""Artwork naming helpers.

Deliberately import-light -- no fitz, no PIL, no boto3 -- so it can be unit
tested without the container's image stack, the same way guards.py and
finishing_config.py are.
"""

import os


def artwork_extension(item, url=""):
    """The file extension to save an item's artwork under.

    `artworkExt` is what intake already resolved, and on the legacy QTS path it
    is the ONLY correct answer: those URLs are a redirect endpoint
    (.../file_redirect.aspx?file=..._FILE_name_IS___IMG9281.png), so the path
    ends in .aspx while the real extension sits in the query string. Reading it
    off the path threw "Unsupported file extension: aspx" and failed order
    203492170 through all four retries during the 2026-09-13 window.

    The URL is only a fallback, for items intake could not resolve.
    """
    ext = str((item or {}).get("artworkExt") or "").strip().lstrip(".").lower()
    if ext:
        return ext
    return (os.path.splitext(str(url).split("?")[0])[1][1:] or "pdf").lower()


# What a file IS, from its first bytes. The extension is whatever the customer's
# file was called, and that is not evidence: S64856 (2026-09-30) was a 519 MB
# Photoshop document named Backdrop.pdf. MuPDF opened it as an image, so it
# passed the one-page check, and then failed in the PDF path ("is no PDF")
# four times over.
_SIGNATURES = (
    (b"%PDF", "pdf"),
    (b"8BPS", "psd"),
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpg"),
    (b"II*\x00", "tif"),
    (b"MM\x00*", "tif"),
    (b"%!PS", "ps"),
)

# Which converter path each format takes. Two names on the same route are the
# same decision, so an .ai that holds a PDF stays "ai" (converter sniffs it
# again) and a .jpeg stays "jpeg".
_ROUTE = {"pdf": "pdf", "eps": "pdf", "ai": "ai", "psd": "psd", "ps": "ai",
          "png": "raster", "jpg": "raster", "jpeg": "raster",
          "tif": "raster", "tiff": "raster"}


def sniff_format(path):
    """The format the bytes say, or None when they say nothing we know."""
    try:
        with open(path, "rb") as f:
            head = f.read(16)
    except OSError:
        return None
    for magic, fmt in _SIGNATURES:
        if head.startswith(magic):
            return fmt
    return None


def corrected_extension(ext, path):
    """The extension to process this file under.

    The named one, unless the bytes clearly belong to a different converter
    path -- then the format the bytes say. Unknown bytes keep the name, so
    nothing that converts today is routed differently tomorrow.
    """
    ext = (ext or "").lower()
    real = sniff_format(path)
    if real is None or _ROUTE.get(real) == _ROUTE.get(ext):
        return ext
    # An .ai is either a PDF or PostScript inside, and the converter's .ai path
    # already sniffs which; an .eps that is PostScript stays as named.
    if (ext == "ai" and real in ("pdf", "ps")) or (ext == "eps" and real == "ps"):
        return ext
    return "ai" if real == "ps" else real
