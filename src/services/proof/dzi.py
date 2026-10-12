"""DZI deep-zoom + derivative proof images — ported from legacy dzi/dziConverter.py.

H logic preserved:
  - DZI tiling: pyvips dzsave, tile_size=256, overlap=1, .jpg suffix, dz layout
    (chosen so the viewer keeps full resolution while zooming)
  - derivatives (all CMYK->RGB, LANCZOS thumbnail):
      thumbnail 300px / bleed 600px / review 800px / proof 500px

Local-disk paths from the legacy (ORDER_PATH/DZI_PATH) become explicit file /
directory arguments; S3 plumbing lives in main.py.
"""

import io
import os

import pyvips
from PIL import Image, ImageCms

Image.MAX_IMAGE_PIXELS = None


def create_dzi(source_path, output_base):
    """pyvips dzsave -> {output_base}.dzi + {output_base}_files/ pyramid."""
    image = pyvips.Image.new_from_file(source_path, access="sequential")
    if image.interpretation == "cmyk":
        # A CMYK print file (stickers, 2026-10-12) would tile as CMYK jpgs the
        # browser shows wrong; convert through its own profile.
        image = image.icc_transform("srgb") if "icc-profile-data" in image.get_fields() else image.colourspace("srgb")
    image.dzsave(output_base, tile_size=256, overlap=1, suffix=".jpg", layout="dz")
    return True


def to_screen_rgb(img):
    """CMYK -> RGB for a screen: through the file's own profile when it has one
    (a sticker's SWOP v2), else the plain conversion legacy used."""
    icc = img.info.get("icc_profile")
    if icc:
        try:
            return ImageCms.profileToProfile(img, ImageCms.ImageCmsProfile(io.BytesIO(icc)),
                                             ImageCms.createProfile("sRGB"), outputMode="RGB")
        except Exception:
            pass
    return img.convert("RGB")


def _derivative(source_path, output_path, max_px):
    with Image.open(source_path) as img:
        if img.mode == "CMYK":
            img = to_screen_rgb(img)
        img.thumbnail((max_px, max_px), Image.LANCZOS)
        img.save(output_path, "PNG")  # legacy saved .jpg-named files as PNG data
    return True


def make_thumbnail(source_path, output_path):
    return _derivative(source_path, output_path, 300)


def make_bleed(source_path, output_path):
    return _derivative(source_path, output_path, 600)


def make_review(source_path, output_path):
    return _derivative(source_path, output_path, 800)


def make_proof(source_path, output_path):
    return _derivative(source_path, output_path, 500)


def prepare_proof(source_path, out_dir, name):
    """Legacy prepareProof per file: DZI + thumbnail + bleed (+ review)."""
    base = os.path.join(out_dir, name)
    create_dzi(source_path, base)
    make_thumbnail(source_path, f"{base}_thumbnail.jpg")
    make_bleed(source_path, f"{base}_bleed.jpg")
    make_review(source_path, f"{base}_review.jpg")
    return True
