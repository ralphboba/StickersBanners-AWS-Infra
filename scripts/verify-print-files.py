#!/usr/bin/env python3
"""Machine check of the print files the window produced.

What this can prove: that each TIFF is the size the order asked for, at the dpi,
colour mode and compression production expects, and that the copy sitting on the
FTP server is byte-for-byte the same size as the one we produced.

What it cannot prove: that the CO cut marks are where the CO cutter expects
them. Nobody has ever compared our CO output against Linh's. That needs a person
who knows the process.

Run of 2026-09-13: 20 print files, 19 clean. The one finding was an RGBA file
rather than RGB -- and checking Linh's transparencyCheck.py showed our code is
identical to his, so a PNG whose alpha channel is present but fully opaque has
always produced an RGBA print file. Whether production minds is a question for
him, not a bug to fix here.

Usage:
  node -e ... > /tmp/verify-orders.json   # {order: [{itemNo,width,height,unit,finishingObj}]}
  python3 scripts/verify-print-files.py

Sizing rules, from src/services/finish/pole_pockets.py:
    base            round(inches * 72) per side
    PPTO / PPBO     height + 324   (4.5in pocket)
    PPTB            height + 648
    PPL / PPR       width  + 324
    PPS             width  + 648
    CO / HO / none  unchanged -- they are labels, not geometry
"""

import json
import os
import subprocess
import sys
import tempfile

from PIL import Image

Image.MAX_IMAGE_PIXELS = None

BUCKET = "sb-dev-finished-025857592188"
REGION = "us-east-1"
POCKET = 324

HEIGHT_ADD = {"PPTO": POCKET, "PPBO": POCKET, "PPTB": 2 * POCKET}
WIDTH_ADD = {"PPL": POCKET, "PPR": POCKET, "PPS": 2 * POCKET}


def aws(args, binary=False):
    return subprocess.run(
        ["env", "-u", "AWS_ACCESS_KEY_ID", "-u", "AWS_SECRET_ACCESS_KEY", "aws"] + args,
        capture_output=True, check=True).stdout if binary else subprocess.run(
        ["env", "-u", "AWS_ACCESS_KEY_ID", "-u", "AWS_SECRET_ACCESS_KEY", "aws"] + args,
        capture_output=True, text=True, check=True).stdout


def expected_px(item):
    scale = 12 if item.get("unit") == "ft" else 1
    w_in = float(item["width"]) * scale
    h_in = float(item["height"]) * scale
    w = round(w_in * 72)
    h = round(h_in * 72)
    suf = (item.get("finishingObj") or {}).get("descSuf") or ""
    return w + WIDTH_ADD.get(suf, 0), h + HEIGHT_ADD.get(suf, 0), suf


def main():
    orders = json.load(open("/tmp/verify-orders.json"))
    ftp_sizes = json.load(open("/tmp/ftp-sizes.json")) if os.path.exists("/tmp/ftp-sizes.json") else {}

    findings = []
    checked = 0

    for order, items in orders.items():
        listing = aws(["s3", "ls", f"s3://{BUCKET}/{order}/", "--region", REGION])
        tifs = {}
        for line in listing.splitlines():
            parts = line.split(None, 3)
            if len(parts) == 4 and parts[3].endswith(".tif"):
                tifs[parts[3]] = int(parts[2])

        for item in items:
            no = item["itemNo"]
            w_exp, h_exp, suf = expected_px(item)
            match = [n for n in tifs if n.startswith(f"{order}-{no}-1 ")]
            if not match:
                findings.append(f"{order} item {no}: NO print file produced")
                continue
            name = match[0]

            with tempfile.TemporaryDirectory() as tmp:
                local = os.path.join(tmp, "f.tif")
                aws(["s3", "cp", f"s3://{BUCKET}/{order}/{name}", local,
                     "--region", REGION, "--quiet"])
                with Image.open(local) as im:
                    got_w, got_h = im.size
                    mode = im.mode
                    dpi = im.info.get("dpi")
                    comp = im.info.get("compression")

            checked += 1
            problems = []
            if (got_w, got_h) != (w_exp, h_exp):
                problems.append(f"size {got_w}x{got_h}, expected {w_exp}x{h_exp}")
            if mode != "RGB":
                problems.append(f"mode {mode}, expected RGB")
            if dpi and (round(dpi[0]), round(dpi[1])) != (72, 72):
                problems.append(f"dpi {dpi}, expected 72x72")
            if comp != "tiff_lzw":
                problems.append(f"compression {comp}, expected tiff_lzw")

            ftp_size = ftp_sizes.get(f"{order}/{name}")
            if ftp_size is not None and ftp_size != tifs[name]:
                problems.append(f"FTP copy {ftp_size} bytes vs S3 {tifs[name]}")

            status = "OK " if not problems else "!! "
            src = f"{item['width']}x{item['height']}{item.get('unit','')}"
            print(f"{status}{order}-{no} {suf or '(none)':5} {src:>10} -> "
                  f"{got_w}x{got_h}px {mode} {comp}"
                  + ("   " + "; ".join(problems) if problems else ""))
            if problems:
                findings.append(f"{order}-{no} ({suf or 'no finishing'}): " + "; ".join(problems))

    print(f"\nchecked {checked} print files")
    if findings:
        print(f"\n{len(findings)} PROBLEM(S):")
        for f in findings:
            print("  -", f)
    else:
        print("\nEvery file matches the ordered size, 72dpi, RGB, tiff_lzw.")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
