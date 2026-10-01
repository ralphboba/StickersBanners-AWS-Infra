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
