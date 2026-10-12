"""Sticker shapes (Kai, 2026-10-12).

What the GA office does in Photoshop for a round sticker, done in code: a
canvas at the sticker's size and resolution, an ellipse the size of the canvas,
the art clipped to it. Outside the shape is white -- no ink, and nothing there
is kept: the cutter cuts along the shape. Round and oval are clipped; a bumper
sticker is a rectangle and stays as resized.

Round stickers are fitted to the ART, not to the file: customers upload a round
logo with an empty margin around it, and the office cuts that margin away so
the logo fills the sticker -- otherwise it prints as a white ring inside the
cut. Measured on 50 office files (2026-10-12): every round sticker matched
this way. Ovals and bumpers keep their white when it is the background of a
logo (S65290, S65004, S67826 kept it), but lose it when it is only a border
round a filled design (S65883, S65819, S68045: a coloured rectangle in a white
frame) -- the office trims the frame. Art that is not roughly round once the
margin is gone (S67093: a phone screenshot with black bars) cannot be fitted
without squashing it, so a person gets it.

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

import numpy as np
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


# Near-white or near-transparent is "empty": the margin a round logo sits in.
EMPTY_WHITE = 240
EMPTY_ALPHA = 16
# Once the margin is gone, round art more than 10% away from round is held for
# a person rather than squashed to fit.
SHAPE_TOLERANCE = 1.10
# A design whose outline is this much ink is a filled shape in a frame -- the
# frame is cut. A logo on white touches its box only here and there.
FILLED_EDGE = 0.8


class StickerArtNotRound(ValueError):
    """The art, without its margin, is not the sticker's shape."""


def content_box(image):
    """(left, top, right, bottom) of the art inside its empty margin."""
    ink = _ink(image)
    rows, cols = np.any(ink, axis=1), np.any(ink, axis=0)
    if not rows.any():
        return (0, 0, image.size[0], image.size[1])
    top, bottom = np.argmax(rows), len(rows) - np.argmax(rows[::-1])
    left, right = np.argmax(cols), len(cols) - np.argmax(cols[::-1])
    return (int(left), int(top), int(right), int(bottom))


def _ink(image):
    if image.mode == "CMYK":
        return np.asarray(image).max(axis=-1) > 255 - EMPTY_WHITE
    rgba = np.asarray(image.convert("RGBA"))
    return (rgba[..., 3] > EMPTY_ALPHA) & (rgba[..., :3].min(axis=-1) < EMPTY_WHITE)


def edge_ink(image, box):
    """Share of the box's outline that is ink: ~1 for a filled design."""
    ink = _ink(image.crop(box))
    if ink.shape[0] < 3 or ink.shape[1] < 3:
        return 1.0
    ring = np.concatenate([ink[0], ink[-1], ink[1:-1, 0], ink[1:-1, -1]])
    return float(ring.mean())


def make_sticker(source_path, ext, width_in, height_in, dpi, shape, output_path, render, source_size):
    """The sticker's print file at `output_path`, fitted to the art.

    render(path, width_in, height_in, unit, output, dpi=...) is converter's
    process_image and source_size(path, ext) orientation's -- passed in so this
    module stays importable without them. The art is first rendered whole, at
    its own shape and 1.6x the sticker's pixels (room for a margin of up to
    ~40%), then its margin is cut (round: always; oval/bumper: only a frame
    round a filled design) and it is fitted to the sticker.
    """
    target = (int(round(float(width_in) * dpi)), int(round(float(height_in) * dpi)))
    size = source_size(source_path, ext)
    aspect = (size[0] / size[1]) if size and size[0] and size[1] else target[0] / target[1]
    side = int(max(target) * 1.6)
    whole_px = (side, max(1, round(side / aspect))) if aspect >= 1 else (max(1, round(side * aspect)), side)
    whole = output_path + ".whole.tif"
    render(source_path, whole_px[0] / dpi, whole_px[1] / dpi, "in", whole, dpi=dpi)
    try:
        with Image.open(whole) as im:
            im.load()
            box = content_box(im)
            if shape == "circle" or edge_ink(im, box) >= FILLED_EDGE:
                art = im.crop(box)
            else:
                art = im.copy()
            icc = im.info.get("icc_profile")
    finally:
        os.remove(whole)
    ratio = (art.size[0] / art.size[1]) / (target[0] / target[1])
    if shape == "circle" and (ratio > SHAPE_TOLERANCE or ratio < 1 / SHAPE_TOLERANCE):
        raise StickerArtNotRound(
            f"the art is {art.size[0]}x{art.size[1]} once its empty margin is cut -- not round enough "
            f"for a {float(width_in):g}x{float(height_in):g} in round sticker without squashing it")
    fitted = art.resize(target, Image.LANCZOS)
    kwargs = {"icc_profile": icc} if icc else {}
    fitted.save(output_path, dpi=(dpi, dpi), compression="tiff_lzw", **kwargs)


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
