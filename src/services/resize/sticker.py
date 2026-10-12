"""Sticker shapes (Kai, 2026-10-12).

What the GA office does in Photoshop for a round sticker, done in code: a
canvas at the sticker's size and resolution, an ellipse the size of the canvas,
the art clipped to it. Outside the shape is white -- no ink, and nothing there
is kept: the cutter cuts along the shape. Round and oval are clipped; a bumper
sticker is a rectangle and stays as resized.

Colour (Kai: "색깔 맞춰야지"): the office's sticker files are CMYK in Photoshop's
default U.S. Web Coated (SWOP) v2 (31 of 58 on the FTP, 2026-10-12; the rest
were left RGB). So the print file is converted the way Photoshop converts --
from the file's own profile, or sRGB when it has none, relative colorimetric
with black point compensation -- and carries the profile. Art that is already
CMYK keeps its numbers.

The size, shape and dpi come from intake (src/shared/sku-config.mjs STICKERS):
item["sticker"] = {"shape": "circle"|"oval"|"rect", "dpi": 650|1000}.
"""

import io
import os

from PIL import Image, ImageCms, ImageDraw

Image.MAX_IMAGE_PIXELS = None

CLIPPED = ("circle", "oval")
SWOP_PATH = os.path.join(os.path.dirname(__file__), "profiles", "USWebCoatedSWOP.icc")
RELATIVE_COLORIMETRIC = 1        # lcms INTENT_RELATIVE_COLORIMETRIC, Photoshop's default
BLACK_POINT_COMPENSATION = 0x2000  # cmsFLAGS_BLACKPOINTCOMPENSATION, on in Photoshop
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


def _profile(icc):
    try:
        return ImageCms.ImageCmsProfile(io.BytesIO(icc)) if icc else None
    except Exception:  # a broken embedded profile is treated as none
        return None


def to_print_cmyk(image):
    """(image in CMYK, profile bytes to embed) -- SWOP v2 as Photoshop makes it."""
    with open(SWOP_PATH, "rb") as f:
        swop = f.read()
    if image.mode == "CMYK":
        return image, image.info.get("icc_profile") or swop
    rgb = image if image.mode == "RGB" else image.convert("RGB")
    source = _profile(image.info.get("icc_profile")) if image.mode == "RGB" else None
    try:
        out = ImageCms.profileToProfile(
            rgb, source or ImageCms.createProfile("sRGB"), ImageCms.ImageCmsProfile(io.BytesIO(swop)),
            renderingIntent=RELATIVE_COLORIMETRIC, outputMode="CMYK", flags=BLACK_POINT_COMPENSATION)
    except ImageCms.PyCMSError:
        # The embedded profile does not describe RGB data: fall back to sRGB.
        out = ImageCms.profileToProfile(
            rgb, ImageCms.createProfile("sRGB"), ImageCms.ImageCmsProfile(io.BytesIO(swop)),
            renderingIntent=RELATIVE_COLORIMETRIC, outputMode="CMYK", flags=BLACK_POINT_COMPENSATION)
    return out, swop


def apply_shape(path, shape, dpi):
    """Make the resized file at `path` the sticker's print file, in place:
    CMYK in SWOP v2, clipped to its shape, at its density."""
    with Image.open(path) as im:
        im.load()
        cmyk, icc = to_print_cmyk(im)
    clipped = clip_to_shape(cmyk, shape)
    clipped.save(path, dpi=(dpi, dpi), compression="tiff_lzw", icc_profile=icc)
