"""Sticker shapes (Kai, 2026-10-12).

What the GA office does in Photoshop for a round sticker, done in code: a
canvas at the sticker's size and resolution, an ellipse the size of the canvas,
the art clipped to it. Outside the shape is white -- no ink, and nothing there
is kept: the cutter cuts along the shape. Round and oval are clipped; a bumper
sticker is a rectangle and stays as resized.

The size, shape and dpi come from intake (src/shared/sku-config.mjs STICKERS):
item["sticker"] = {"shape": "circle"|"oval"|"rect", "dpi": 650|1000}.
"""

from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None

CLIPPED = ("circle", "oval")
WHITE = {"RGB": (255, 255, 255), "CMYK": (0, 0, 0, 0), "L": 255}


def sticker_of(item):
    """The item's sticker spec, or None for anything that is not one."""
    spec = item.get("sticker")
    if not isinstance(spec, dict) or spec.get("shape") not in CLIPPED + ("rect",):
        return None
    try:
        dpi = int(spec.get("dpi"))
    except (TypeError, ValueError):
        return None
    return {"shape": spec["shape"], "dpi": dpi} if dpi > 0 else None


def clip_to_shape(image, shape):
    """The image with everything outside the circle/oval painted white."""
    if shape not in CLIPPED:
        return image
    if image.mode not in WHITE:
        image = image.convert("RGB")
    mask = Image.new("L", image.size, 0)
    # The ellipse fills the canvas exactly, edge to edge, like the Photoshop
    # ellipse drawn at the canvas size.
    ImageDraw.Draw(mask).ellipse((0, 0, image.size[0] - 1, image.size[1] - 1), fill=255)
    out = Image.new(image.mode, image.size, WHITE[image.mode])
    out.paste(image, (0, 0), mask)
    return out


def apply_shape(path, shape, dpi):
    """Clip the print file at `path` in place, keeping its density."""
    if shape not in CLIPPED:
        return
    with Image.open(path) as im:
        im.load()
        clipped = clip_to_shape(im, shape)
    clipped.save(path, dpi=(dpi, dpi), compression="tiff_lzw")
