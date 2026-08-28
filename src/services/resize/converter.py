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


def _convert_pdf(file_path, width_px, height_px, output_path):
    doc = fitz.open(file_path)
    page = doc[0]
    page.set_cropbox(page.trimbox)  # legacy: crop to trimbox
    pix = page.get_pixmap(dpi=300)
    image = Image.open(io.BytesIO(pix.tobytes("png")))
    return _rescale_and_save(image, width_px, height_px, output_path, force_rgba=True)


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
