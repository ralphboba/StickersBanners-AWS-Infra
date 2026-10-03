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
import math
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
# The budget was 700 Mpx, chosen to keep a 4x8 ft page (414 Mpx) at 300 dpi
# and so byte-identical to Linh. It was an estimate, and it was wrong: on
# 2026-09-29 five orders with 6x8 to 10x8 ft PDF pages were killed at 8 GB.
# Measured with their real files on the container's PyMuPDF 1.26.3:
#
#   S64610  6x8 ft, old code at 622 Mpx          8.76 GB  -> killed
#   S64675  19x5 ft, 300 Mpx (after the copy fix) 7.93 GB, 655 s
#   the other five at 300 Mpx                     2.6 - 4.3 GB
#
# Memory is not just our copies of the raster: MuPDF's own render buffers
# (transparency groups, soft masks) scale with the pixel count and vary per
# file, from ~14 to ~26 bytes a pixel on those seven. 160 Mpx puts the worst one
# measured near 4 GB -- half the task.
#
# What it costs: a page above 160 Mpx at 300 dpi (bigger than ~3x4 ft) renders
# below 300 dpi, so its bytes no longer match Linh's. It still renders ABOVE the
# output's own density (the floor in pdf_render_dpi), so the print file is not
# softer -- a 4x8 ft page comes out at ~186 dpi for a 72 dpi print. A 3x4 ft
# page (155.5 Mpx) and everything smaller is untouched.
PDF_MAX_RENDER_PIXELS = 160_000_000


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
    # samples_mv, not samples: `samples` hands back a fresh bytes COPY of the
    # whole raster, so the pixmap, that copy and PIL's own copy were all alive
    # at once -- three full-page rasters. Reading through the memoryview drops
    # the middle one. Same bytes in, same pixels out.
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples_mv)


# Memory is not a function of pixels alone. S65160 (2026-10-01), a 31.5x80 in
# roll-up full of transparency, peaked at 8.76 GB at 160 Mpx -- 55 bytes a pixel,
# twice the worst file the 160 Mpx line was measured on. No fixed budget is
# safe for every file, so the render runs in a child process with a memory
# ceiling: if MuPDF runs out there, the child fails cleanly and the page is
# rendered again at half the density, down to the floor the output needs. A
# file that fits renders once at the same dpi as before -- same bytes.
#
# The ceiling is an address-space limit (RLIMIT_AS) in the child, so the
# failure is an allocation error the parent can see, not the kernel killing the
# whole task. It is a fraction of the task's own cgroup limit.
PDF_CHILD_MEMORY_FRACTION = 0.8
PDF_MEMORY_FAILURE = 75  # child exit code: ran out of memory, try lower dpi


def _container_memory_bytes():
    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            raw = open(path).read().strip()
        except OSError:
            continue
        if raw.isdigit() and int(raw) < 1 << 50:  # "max" / huge = unlimited
            return int(raw)
    return None


def pdf_child_memory_limit(env=None):
    """Bytes the render child may use, or None for no limit."""
    env = os.environ if env is None else env
    explicit = env.get("PDF_CHILD_MEMORY_MB")
    if explicit:
        return int(explicit) * 1024 * 1024
    total = _container_memory_bytes()
    return int(total * PDF_CHILD_MEMORY_FRACTION) if total else None


def _render_pdf_child(file_path, width_px, height_px, output_path, dpi, limit):
    """Child process body: render at `dpi` and save, or exit 75 on memory."""
    import resource
    if limit:
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    try:
        _render_pdf(file_path, width_px, height_px, output_path, dpi)
    except MemoryError:
        os._exit(PDF_MEMORY_FAILURE)
    except Exception as exc:
        if "memory" in str(exc).lower() or "alloc" in str(exc).lower():
            os._exit(PDF_MEMORY_FAILURE)
        print(f"resize: render failed: {type(exc).__name__}: {exc}", flush=True)
        os._exit(1)
    os._exit(0)


def _render_pdf(file_path, width_px, height_px, output_path, dpi):
    doc = fitz.open(file_path)
    page = doc[0]
    page.set_cropbox(page.trimbox)  # legacy: crop to trimbox
    pix = page.get_pixmap(dpi=dpi)
    image = pixmap_to_image(pix)
    # PIL has its own copy now. Let the pixmap and the document go before the
    # resize allocates, instead of holding them to the end of the function.
    del pix, page
    doc.close()
    return _rescale_and_save(image, width_px, height_px, output_path, force_rgba=True)


def _convert_pdf(file_path, width_px, height_px, output_path):
    import multiprocessing
    doc = fitz.open(file_path)
    page = doc[0]
    page.set_cropbox(page.trimbox)  # legacy: crop to trimbox
    rect = fitz.Rect(page.rect)  # a copy: the document closes below
    dpi = pdf_render_dpi(rect, width_px, height_px)
    floor = max(width_px / (rect.width / 72.0), height_px / (rect.height / 72.0)) if rect.width and rect.height else 0
    doc.close()
    if dpi != PDF_RENDER_DPI:
        print(f"resize: {os.path.basename(file_path)} page is "
              f"{rect.width / 72:.1f}x{rect.height / 72:.1f} in — "
              f"rendering at {dpi} dpi instead of {PDF_RENDER_DPI} to stay "
              f"inside {PDF_MAX_RENDER_PIXELS} pixels "
              f"(output is {width_px}x{height_px})")
    limit = pdf_child_memory_limit()
    ctx = multiprocessing.get_context("fork")
    while True:
        child = ctx.Process(target=_render_pdf_child,
                            args=(file_path, width_px, height_px, output_path, dpi, limit))
        child.start()
        child.join()
        if child.exitcode == 0:
            return True
        out_of_memory = child.exitcode in (PDF_MEMORY_FAILURE, -9)
        # Halve, but never below the output's own density -- and do try AT that
        # density before giving up. S65160 item 2 (96x96 in page for a 92 in
        # print) failed at 131 dpi, and half of that (65) is under its 69 dpi
        # floor, so it stopped one step short of the render that fits.
        lower = max(int(dpi / 2), math.ceil(floor))
        if not out_of_memory or lower >= dpi:
            raise RuntimeError(
                f"PDF render failed at {dpi} dpi (exit {child.exitcode})"
                + ("; already at the output's own density" if out_of_memory else ""))
        print(f"resize: {os.path.basename(file_path)} ran out of memory at {dpi} dpi; "
              f"rendering again at {lower} dpi")
        dpi = lower


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
    try:
        composite = PSDImage.open(file_path).composite()
    except Exception as exc:
        # psd-tools 1.10.8 cannot parse some newer Photoshop records: S65512
        # (2026-10-02) carried a version-8 linked layer and failed with
        # "Invalid version 8". Every PSD also stores the flattened image
        # Photoshop shows, and that is what psd-tools' composite() returns
        # anyway when the file has one -- so read it directly with PIL. Files
        # psd-tools CAN open keep the exact path they have always taken.
        print(f"resize: psd-tools could not open {os.path.basename(file_path)} "
              f"({type(exc).__name__}: {exc}); using its stored composite image")
        composite = Image.open(file_path)
        composite.load()
    return _rescale_and_save(composite, width_px, height_px, output_path, force_rgba=True)


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
