"""Final print files the office attached by hand (special instructions).

Those orders are made by hand start to finish (Kai, 2026-10-11): the attached
file is the print file and goes to the facility exactly as it is. Resize does
not size it to the order; it only renders a preview of it for the customer's
proof page and the invoice thumbnail.

Import-light (no PIL, no fitz) so it unit-tests without the image stack.
"""

# Longest side of the preview, in pixels. The proof page zooms a DZI of it and
# the invoice thumbnail is 300 px, so more than this only costs memory.
PREVIEW_MAX_PX = 6000


def is_manual(job):
    """Attached final files, released from the dashboard (instructions.mjs)."""
    return isinstance(job, dict) and job.get("manualFiles") is True


def preview_inches(size, fallback, max_px=PREVIEW_MAX_PX):
    """(width, height) in inches at 72 px/in for the preview of a final file.

    `size` is the file's own (w, h) in pixels or PDF points (both 72 per inch
    for this purpose), or None when it cannot be read; then `fallback` -- the
    ordered (w, h) in inches -- gives the shape. Scaled down so the longest side
    is at most max_px pixels; never scaled up.
    """
    w, h = size if size and size[0] and size[1] else (fallback[0] * 72, fallback[1] * 72)
    scale = min(1.0, max_px / max(w, h))
    return (w * scale / 72.0, h * scale / 72.0)
