"""Image conversion core — ported from legacy SBImageProcessor.

Logic preserved exactly:
  A. Dimensions: in -> px*72, ft -> px*72*12 (72 DPI)
  B. Raster resize: PIL LANCZOS, flatten transparency onto white,
     save TIFF @72dpi with tiff_lzw compression
  C. Format handling:
       raster (jpg/jpeg/png/tif/tiff) -> resize directly
       pdf  -> PyMuPDF render @300dpi, crop to trimbox
       ai   -> header sniff: %PDF -> pdf path, %!PS -> ghostscript (linux `gs`,
               legacy used gswin64c.exe)
       psd  -> psd_tools composite

Changes from legacy (infrastructure only, not logic): local-disk paths replaced
by explicit file arguments; no Redis; no FastAPI.
"""

import io
import os
import subprocess
import tempfile

import fitz  # PyMuPDF
from PIL import Image
from psd_tools import PSDImage

Image.MAX_IMAGE_PIXELS = None  # large-format banners exceed PIL's default guard

VECTOR_FILE_TYPES = ["pdf", "ai", "psd", "eps"]
RASTER_FILE_TYPES = ["jpeg", "jpg", "png", "tiff", "tif"]
# SKUs whose dimensions are quoted in inches even without an "in" suffix.
IN_UNIT_SKUS = ["SKUPB", "SKUXB", "SKU-543"]


def get_dimensions(width, height, unit):
    """A. in -> x72, ft -> x72x12. Returns (w_px, h_px) or (None, None)."""
    width = float(width)
    height = float(height)
    if unit == "in":
        return int(width * 72), int(height * 72)
    if unit == "ft":
        return int(width * 72 * 12), int(height * 72 * 12)
    return None, None


def infer_unit(width_raw, height_raw, sku):
    """Legacy unit rule: 'in' in the raw value, or an in-unit SKU, else ft."""
    w, h = str(width_raw), str(height_raw)
    if ("in" in w) or ("in" in h) or (sku in IN_UNIT_SKUS):
        return "in"
    return "ft"


def check_transparency(img: Image.Image) -> bool:
    if img.mode in ("RGBA", "LA"):
        alpha = img.getchannel("A")
        return any(pixel < 255 for pixel in alpha.getdata())
    if img.mode == "P":
        return "transparency" in img.info
    return False


def flatten_image(img: Image.Image) -> Image.Image:
    white_bg = Image.new("RGB", img.size, (255, 255, 255))
    white_bg.paste(img, mask=img.split()[3])
    return white_bg


def _rescale_and_save(image: Image.Image, width_px, height_px, output_path, force_rgba=False):
    """B. LANCZOS resize -> flatten if transparent -> TIFF 72dpi lzw.

    Legacy has two paths and they differ, so we mirror both exactly:
      * raster (normalFileConverter): NO mode conversion — resize in the source
        mode and only flatten if transparent, so a CMYK/grayscale print file is
        preserved as-is (force_rgba=False).
      * vector (imageRescale, for pdf/ai/psd): always convert to RGBA first, then
        flatten if transparent (force_rgba=True).
    """
    processed = image.resize((width_px, height_px), Image.LANCZOS)
    if force_rgba:
        processed = processed.convert("RGBA")
    if check_transparency(processed):
        processed = flatten_image(processed)
    processed.save(output_path, dpi=(72, 72), compression="tiff_lzw")
    return True


# Legacy renders every PDF at a flat 300 dpi (vectorFileConverter.py:58) and we
# match it, because matching is the whole point of this port. But 300 dpi is a
# density, not a size: the pixel count is the PAGE's area times 300^2, and the
# page is whatever the customer's file happens to be, not what they ordered.
#
# S61866 (2026-09-19) ordered a 6x5 ft banner and uploaded a PDF whose trimbox
# is 120x96 in. At 300 dpi that page is 36,000 x 28,799 = 1.037 BILLION pixels:
# 3.1 GB for the pixmap, another 3.1 GB once PIL decodes it, 4.1 GB again after
# convert("RGBA"). The 8 GB container was killed (exit 137) on all four
# attempts, so the order produced nothing at all. Linh's program has the same
# flat 300 dpi; his PC survives it on swap, ours does not survive it on a hard
# cgroup limit.
#
# The resolution is not needed in the first place. The render is immediately
# resized to width_px x height_px, so every pixel beyond that is decoded and
# then thrown away by LANCZOS — for S61866, 98% of them.
#
# So: keep 300 dpi wherever 300 dpi fits, and step down only when it does not.
# A file that renders today renders identically tomorrow (same dpi, same bytes);
# a file that is killed today gets the lower density instead of nothing. The
# floor is the output size itself, so the step-down can never sample BELOW the
# pixels the resize is about to ask for.
PDF_RENDER_DPI = 300
# The budget has to be high enough that it never touches a page that renders
# fine today -- stepping the dpi down on a working file would change its output
# bytes, and matching Linh byte for byte is the thing being protected. A 4x8 ft
# page (48x96 in) is a real banner layout and comes to 414 Mpx at 300 dpi, so
# the line sits above that.
#
# 700 Mpx is ~2.1 GB for the pixmap and ~2.8 GB once converted to RGBA, so the
# peak lands near 4.9 GB of the task's 8 GB. S61866's 1,037 Mpx is the only
# page measured over the line, and it steps down to 246 dpi rather than dying.
PDF_MAX_RENDER_PIXELS = 700_000_000


def pdf_render_dpi(page_rect, width_px, height_px,
                   dpi=PDF_RENDER_DPI, max_pixels=PDF_MAX_RENDER_PIXELS):
    """The dpi to rasterise a page at: `dpi`, unless that blows the pixel budget.

    Returns `dpi` unchanged whenever the page fits, so the common case is
    byte-for-byte what it has always been. When it does not fit, returns the
    largest dpi that does -- floored at the density the output actually needs,
    since rendering below that would lose real detail rather than waste.
    """
    width_in = page_rect.width / 72.0
    height_in = page_rect.height / 72.0
    if width_in <= 0 or height_in <= 0:
        return dpi

    if width_in * dpi * height_in * dpi <= max_pixels:
        return dpi

    # Largest dpi whose pixel count still fits, as a whole number.
    fitted = int((max_pixels / (width_in * height_in)) ** 0.5)
    # Never sample below what the resize is going to ask for anyway.
    needed = max(width_px / width_in, height_px / height_in)
    return max(1, min(dpi, max(fitted, int(needed + 0.5))))


def pixmap_to_image(pix):
    """A rendered page as a PIL image, without the PNG round trip.

    This used to be Image.open(io.BytesIO(pix.tobytes("png"))): encode the whole
    raster to PNG in memory, then decode it straight back. PNG is lossless, so
    the pixels either way are the same ones -- test_pdf_render.py pins that --
    but the trip costs an encode, a decode and two more full-size copies live at
    once, on the exact files that are already too big. Reading pix.samples is
    the same raster with none of that.
    """
    if pix.alpha:
        # PyMuPDF keeps alpha pixmaps PREMULTIPLIED while the PNG encoder writes
        # straight alpha, so for these two the raw samples and the PNG really do
        # hold different numbers — test_pixmap_to_image.py pins it. _convert_pdf
        # never asks for alpha (get_pixmap(dpi=...) defaults to none), so this
        # branch exists only so a future caller cannot get silently wrong
        # colour. Pay for the round trip rather than guess at un-premultiplying.
        return Image.open(io.BytesIO(pix.tobytes("png")))
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def _convert_pdf(file_path, width_px, height_px, output_path):
    doc = fitz.open(file_path)
    page = doc[0]
    page.set_cropbox(page.trimbox)  # legacy: crop to trimbox
    dpi = pdf_render_dpi(page.rect, width_px, height_px)
    if dpi != PDF_RENDER_DPI:
        print(f"resize: {os.path.basename(file_path)} page is "
              f"{page.rect.width / 72:.1f}x{page.rect.height / 72:.1f} in — "
              f"rendering at {dpi} dpi instead of {PDF_RENDER_DPI} to stay "
              f"inside {PDF_MAX_RENDER_PIXELS} pixels "
              f"(output is {width_px}x{height_px})")
    pix = page.get_pixmap(dpi=dpi)
    return _rescale_and_save(pixmap_to_image(pix), width_px, height_px,
                             output_path, force_rgba=True)


def _convert_postscript(file_path, width_px, height_px, output_path):
    """PostScript-flavoured .ai via Ghostscript (linux `gs`, was gswin64c.exe)."""
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_png = tmp.name
    try:
        subprocess.run(
            ["gs", "-dBATCH", "-dNOPAUSE", "-sDEVICE=png16m", "-r300",
             f"-sOutputFile={tmp_png}", file_path],
            check=True,
        )
        return _rescale_and_save(Image.open(tmp_png), width_px, height_px, output_path, force_rgba=True)
    finally:
        if os.path.exists(tmp_png):
            os.remove(tmp_png)


def _convert_ai(file_path, width_px, height_px, output_path):
    """Legacy AI detection: %PDF header -> pdf path, %!PS -> ghostscript."""
    with open(file_path, "rb") as f:
        header = f.read(5)
    if header.startswith(b"%PDF"):
        return _convert_pdf(file_path, width_px, height_px, output_path)
    if header.startswith(b"%!PS"):
        return _convert_postscript(file_path, width_px, height_px, output_path)
    raise ValueError("Unknown or unsupported AI format")


def _convert_psd(file_path, width_px, height_px, output_path):
    psd = PSDImage.open(file_path)
    return _rescale_and_save(psd.composite(), width_px, height_px, output_path, force_rgba=True)


def check_pdf_pages(file_path) -> int:
    try:
        return fitz.open(file_path).page_count
    except Exception:
        return 0


def process_image(file_path, width, height, unit, output_path):
    """C. Route by extension; returns True or raises."""
    width_px, height_px = get_dimensions(width, height, unit)
    if width_px is None:
        raise ValueError(f"Invalid unit {unit}")

    ext = os.path.splitext(file_path)[1][1:].lower()
    if ext in RASTER_FILE_TYPES:
        with Image.open(file_path) as img:
            return _rescale_and_save(img, width_px, height_px, output_path)
    if ext in ("pdf", "eps"):
        return _convert_pdf(file_path, width_px, height_px, output_path)
    if ext == "ai":
        return _convert_ai(file_path, width_px, height_px, output_path)
    if ext == "psd":
        return _convert_psd(file_path, width_px, height_px, output_path)
    raise ValueError(f"Unsupported file extension: {ext}")
