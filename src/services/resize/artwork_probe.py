"""Read-only artwork check: would resize be able to use this file?

The daily census (scripts/daily-census.mjs) answers "can we process today's
orders" from the ORDER RECORD alone — routing, the intake gate, sizes,
finishing. That is most of it, but it is blind to the customer's file, and the
file is where two of the three real failures on 2026-09-19 came from:

  S61790  a two-page PDF; legacy and we both print single-page only
  S61866  a 120x96 in PDF page, 1.037 billion pixels at 300 dpi, OOM

Neither is visible until something opens the file. So this does, using the SAME
functions resize uses — artwork_extension, download, check_pdf_pages,
pdf_render_dpi — because a probe with its own copy of the rules would only ever
test the copy.

It produces NO print files, uploads nothing to the processed bucket and writes
nothing to DynamoDB. The one thing it writes is its own report.

Run contract (env):

  PROBE_INPUT_BUCKET / PROBE_INPUT_KEY    JSON list of items to check
  PROBE_OUTPUT_BUCKET / PROBE_OUTPUT_KEY  where the report goes
  PROBE_MAX_BYTES    per-file cap, default 268435456 (256 MiB)
  PROBE_MAX_FILES    stop after this many, default 500

Each input item: {orderName, itemNo, sku, name, url, width, height, unit}
"""

import io
import json
import os
import sys
import tempfile
import time

import boto3
from PIL import Image

from artwork import artwork_extension
from converter import (PDF_MAX_RENDER_PIXELS, PDF_RENDER_DPI, check_pdf_pages,
                       get_dimensions, pdf_render_dpi)
from fetch import download

Image.MAX_IMAGE_PIXELS = None  # same as converter: banners exceed PIL's guard

DEFAULT_MAX_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_FILES = 500

s3 = boto3.client("s3")


def _env_int(name, default):
    try:
        value = int(os.environ.get(name, "").strip())
    except ValueError:
        return default
    return value if value > 0 else default


def probe_pdf(path, width_px, height_px):
    """What resize would hit on this PDF, without rendering it."""
    import fitz

    pages = check_pdf_pages(path)
    if pages != 1:
        return {"verdict": "unusable", "reason": "multi-page-pdf",
                "detail": f"{pages} pages; only single-page PDFs can be printed"}

    doc = fitz.open(path)
    page = doc[0]
    page.set_cropbox(page.trimbox)
    rect = page.rect
    page_w_in = rect.width / 72.0
    page_h_in = rect.height / 72.0
    at_300 = page_w_in * PDF_RENDER_DPI * page_h_in * PDF_RENDER_DPI
    dpi = pdf_render_dpi(rect, width_px, height_px)
    doc.close()

    info = {
        "pageInches": [round(page_w_in, 2), round(page_h_in, 2)],
        "pixelsAt300dpi": int(at_300),
        "renderDpi": dpi,
    }
    if dpi < PDF_RENDER_DPI:
        # Survivable now, but this is the S61866 shape: before the dpi cap it
        # was an OOM kill and no output at all.
        return {"verdict": "warn", "reason": "oversized-pdf-page",
                "detail": (f"page is {page_w_in:.0f}x{page_h_in:.0f} in — "
                           f"{int(at_300):,} px at {PDF_RENDER_DPI} dpi, "
                           f"rendering at {dpi} dpi to stay under "
                           f"{PDF_MAX_RENDER_PIXELS:,}"),
                **info}
    return {"verdict": "ok", **info}


def probe_raster(path):
    """Open it the way PIL will have to, and report what it costs."""
    with Image.open(path) as img:
        width, height = img.size
        mode = img.mode
    megapixels = width * height / 1e6
    info = {"sourcePixels": [width, height], "mode": mode,
            "megapixels": round(megapixels, 1)}
    # resize holds the decoded source and its resized copy at once; the task has
    # 8 GB. 400 Mpx as RGBA is 1.6 GB before a single copy.
    if megapixels > 400:
        return {"verdict": "warn", "reason": "huge-source-image",
                "detail": f"{megapixels:.0f} Mpx source", **info}
    return {"verdict": "ok", **info}


def probe_item(item, scratch, max_bytes):
    """One line item's artwork. Never raises — a probe that dies is useless."""
    out = {"orderName": item.get("orderName"), "itemNo": item.get("itemNo"),
           "sku": item.get("sku"), "name": item.get("name")}
    url = item.get("url") or ""
    if not url:
        return {**out, "verdict": "unusable", "reason": "no-artwork-url"}

    ext = artwork_extension(item, url)
    out["ext"] = ext
    local = os.path.join(scratch, f"probe.{ext}")
    started = time.time()
    # fetch.download takes its bounds from the environment, not arguments, so
    # the probe's cap is handed over the same way -- and through the same code
    # path resize uses, timeouts and retries included.
    env = {**os.environ, "ARTWORK_MAX_BYTES": str(max_bytes)}
    try:
        size = download(url, local, env=env)
    except Exception as err:
        return {**out, "verdict": "unusable", "reason": "download-failed",
                "detail": f"{type(err).__name__}: {str(err)[:300]}"}
    out["bytes"] = size
    out["fetchSeconds"] = round(time.time() - started, 1)

    width_px, height_px = get_dimensions(item.get("width"), item.get("height"),
                                         item.get("unit"))
    if not width_px or not height_px:
        return {**out, "verdict": "unusable", "reason": "no-output-size",
                "detail": "the order carries no usable width/height"}
    out["outputPixels"] = [width_px, height_px]

    try:
        if ext in ("pdf", "eps"):
            result = probe_pdf(local, width_px, height_px)
        elif ext in ("ai", "psd"):
            result = {"verdict": "skipped", "reason": f"{ext} not probed"}
        else:
            result = probe_raster(local)
    except Exception as err:
        result = {"verdict": "unusable", "reason": "cannot-open",
                  "detail": f"{type(err).__name__}: {str(err)[:300]}"}
    finally:
        if os.path.exists(local):
            os.remove(local)
    return {**out, **result}


def main():
    items = json.loads(s3.get_object(
        Bucket=os.environ["PROBE_INPUT_BUCKET"],
        Key=os.environ["PROBE_INPUT_KEY"])["Body"].read())
    max_bytes = _env_int("PROBE_MAX_BYTES", DEFAULT_MAX_BYTES)
    max_files = _env_int("PROBE_MAX_FILES", DEFAULT_MAX_FILES)

    results = []
    with tempfile.TemporaryDirectory() as scratch:
        for item in items[:max_files]:
            result = probe_item(item, scratch, max_bytes)
            results.append(result)
            if result.get("verdict") != "ok":
                print(json.dumps(result))

    counts = {}
    for r in results:
        counts[r.get("verdict")] = counts.get(r.get("verdict"), 0) + 1
    report = {"checked": len(results), "skippedOverCap": max(0, len(items) - max_files),
              "counts": counts, "results": results}
    s3.put_object(Bucket=os.environ["PROBE_OUTPUT_BUCKET"],
                  Key=os.environ["PROBE_OUTPUT_KEY"],
                  Body=json.dumps(report, indent=2).encode(),
                  ContentType="application/json")
    print(json.dumps({"checked": len(results), "counts": counts}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"artwork probe failed: {exc}", file=sys.stderr)
        sys.exit(1)
