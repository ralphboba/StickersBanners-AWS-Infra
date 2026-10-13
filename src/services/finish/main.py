"""Finish service entrypoint (ECS Fargate, run-to-completion).

F. Finishing orchestration — ported from legacy finisher/finisher.py with the
local-disk plumbing replaced by S3. Per item, in legacy order:
  1. create the proof file (300px jpg thumbnail, CMYK -> RGB)
  2. no finishing -> plain copy
  3. grommets (output becomes the next input)
  4. specialFinishing (pole pockets)
  5. final name: "{orderId}-{itemNo} {descSuf}[ qty N].tif"

Run contract: ORDER_NAME + JOB env (Step Functions overrides); reads
processed/{order}/{itemNo}v1.tif, writes finished/{order}/..., records
STEP#finish in DynamoDB.
"""

import io
import json
import os
import shutil
import sys
import tempfile

import boto3

from jobload import load_job
from PIL import Image, ImageCms

from finishing_config import (build_finishing_obj, final_tif_name, manual_final_name, s3_key_of,
                              sticker_final_name)
from sticker_sheet import make_sheet, sheet_name
from grommets import GrommetsAdder
from guides import compute_guides, guides_key
from pole_pockets import PolePocketsAdder

Image.MAX_IMAGE_PIXELS = None

s3 = boto3.client("s3")
ddb = boto3.resource("dynamodb")

PROCESSED_BUCKET = os.environ["PROCESSED_BUCKET"]
FINISHED_BUCKET = os.environ["FINISHED_BUCKET"]
JOBS_TABLE = os.environ.get("JOBS_TABLE", "")
UPLOADS_BUCKET = os.environ.get("UPLOADS_BUCKET", "")


def create_proof_file(source_path, proof_path, managed=False):
    """Legacy createProofFile: 300px thumbnail jpg (CMYK converted to RGB).

    managed: convert CMYK through the file's own profile (a sticker's SWOP v2)
    rather than legacy's plain convert, which oversaturates it. Banners keep
    legacy's bytes.
    """
    with Image.open(source_path) as img:
        if img.mode == "CMYK" and managed and img.info.get("icc_profile"):
            img = ImageCms.profileToProfile(img, ImageCms.ImageCmsProfile(io.BytesIO(img.info["icc_profile"])),
                                            ImageCms.createProfile("sRGB"), outputMode="RGB")
        elif img.mode == "CMYK":
            img = img.convert("RGB")
        img.thumbnail((300, 300), Image.LANCZOS)
        img.save(proof_path, "PNG")


def has_no_finishing(finishing_obj):
    """Legacy rule: only quantity, or only quantity+descSuf => plain copy."""
    keys = set(finishing_obj.keys())
    return keys <= {"quantity", "descSuf"}


def record_step(order_name, state, detail=""):
    if not JOBS_TABLE:
        return
    ddb.Table(JOBS_TABLE).put_item(Item={
        "PK": f"ORDER#{order_name}",
        "SK": "STEP#finish",
        "state": state,
        "detail": detail,
    })


def set_stage(order_name, stage):
    """Live sub-step shown on the dashboard while status is 'printing'."""
    if not JOBS_TABLE:
        return
    try:
        ddb.Table(JOBS_TABLE).update_item(
            Key={"PK": f"ORDER#{order_name}", "SK": "META"},
            UpdateExpression="SET #st = :s",
            ExpressionAttributeNames={"#st": "stage"},
            ExpressionAttributeValues={":s": stage},
        )
    except Exception:
        pass  # cosmetic only — never fail the job over the stage label


def upload_guides(order_name, item_no, src, finishing_obj):
    """Sidecar for the proof page, kept out of the print folder (guides_key).

    Uses its own adder instances, so the print file's are never touched.
    Never fails the job — the page works without it.
    """
    try:
        with Image.open(src) as img:
            width, height = img.size
        guides = compute_guides(width, height, finishing_obj)
        s3.put_object(Bucket=FINISHED_BUCKET, Key=guides_key(order_name, item_no),
                      Body=json.dumps(guides).encode(), ContentType="application/json")
    except Exception as exc:
        print(f"finish: guides skipped for {order_name}/{item_no}: {exc}", file=sys.stderr)


def clear_finished(order_name):
    """Remove what an earlier run left in finished/{order}/ -- transfer sends
    everything there, and a final file must not travel with old print files."""
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=FINISHED_BUCKET, Prefix=f"{order_name}/"):
        for obj in page.get("Contents", []):
            s3.delete_object(Bucket=FINISHED_BUCKET, Key=obj["Key"])


def finish_manual(order_name, items):
    """Final files the office attached (special instructions, instructions.mjs).

    No grommets, no pole pockets, no guides: each file goes to the facility
    exactly as attached, named "{order}-{item} {their name}". Only the invoice
    thumbnail is made, from resize's preview.
    """
    clear_finished(order_name)
    produced = []
    with tempfile.TemporaryDirectory() as scratch:
        for i, item in enumerate(items, start=1):
            item_no = f"{item.get('itemNo', i)}-1"
            preview = os.path.join(scratch, f"{item_no}v1.tif")
            s3.download_file(PROCESSED_BUCKET, f"{order_name}/{item_no}v1.tif", preview)
            thumb = os.path.join(scratch, f"{item_no}.jpg")
            create_proof_file(preview, thumb)
            s3.upload_file(thumb, FINISHED_BUCKET, f"{order_name}/{item_no}.jpg")

            key = s3_key_of(item.get("artworkUrl"))
            if not key:
                raise RuntimeError(f"item {item_no} has no attached final file")
            final = os.path.join(scratch, f"final-{item_no}")
            s3.download_file(UPLOADS_BUCKET, key, final)
            name = manual_final_name(order_name, item_no, item.get("finalFileName") or key)
            s3.upload_file(final, FINISHED_BUCKET, f"{order_name}/{name}")
            produced.append(f"{order_name}/{name}")
            print(f"finish: final file as attached -> s3://{FINISHED_BUCKET}/{order_name}/{name}")
    return produced


def main():
    order_name = os.environ["ORDER_NAME"]
    set_stage(order_name, "finishing")
    job = load_job(order_name)
    items = job.get("items", [])
    if job.get("manualFiles") is True:
        produced = finish_manual(order_name, items)
        record_step(order_name, "done", detail=json.dumps(produced))
        print(json.dumps({"orderName": order_name, "produced": produced, "manual": True}))
        return
    grommet = GrommetsAdder()
    pockets = PolePocketsAdder()
    produced = []

    with tempfile.TemporaryDirectory() as scratch:
        for i, item in enumerate(items, start=1):
            # itemNo comes from intake and predates the hardware filter — see
            # the note in resize/main.py.
            item_no = f"{item.get('itemNo', i)}-1"
            src_key = f"{order_name}/{item_no}v1.tif"
            src = os.path.join(scratch, f"{item_no}v1.tif")
            s3.download_file(PROCESSED_BUCKET, src_key, src)

            # A sticker gets no finishing at all -- resize already cut it to
            # its shape -- and the GA office's name, not the banner one.
            sticker = isinstance(item.get("sticker"), dict)
            finishing_obj = {"quantity": item.get("quantity", 1)} if sticker else build_finishing_obj(item)
            work = os.path.join(scratch, f"{item_no}.tif")

            # 1. proof thumbnail
            proof = os.path.join(scratch, f"{item_no}.jpg")
            create_proof_file(src, proof, managed=isinstance(item.get("sticker"), dict))
            proof_key = f"{order_name}/{item_no}.jpg"
            s3.upload_file(proof, FINISHED_BUCKET, proof_key)
            upload_guides(order_name, item_no, src, finishing_obj)

            # 2. no finishing -> copy
            if has_no_finishing(finishing_obj):
                shutil.copy(src, work)

            current_source = src

            # 3. grommets (result becomes source for further finishing)
            if "grommets" in finishing_obj:
                g = finishing_obj["grommets"]
                grommet.addGrommets(
                    sides=g.get("sides"),
                    convertedFileDir=work,
                    sourceFileDir=current_source,
                    widthGrommetsCounts=g.get("widthGrommets", 2),
                    heightGrommetsCounts=g.get("heightGrommets", 2),
                )
                current_source = work

            # 4. pole pockets / retractable
            if "specialFinishing" in finishing_obj:
                pockets.addPolePockets(
                    mode=finishing_obj["specialFinishing"],
                    sourceFileDir=current_source,
                    convertedFileDir=work,
                )

            # 5. final naming: "{orderId}-{itemNo} {descSuf}[ qty N].tif"
            final_name = (sticker_final_name(order_name, item.get("itemNo", i), item.get("quantity", 1), len(items) > 1)
                          if sticker else final_tif_name(order_name, item_no, finishing_obj))
            final_key = f"{order_name}/{final_name}"
            s3.upload_file(work, FINISHED_BUCKET, final_key)
            produced.append(final_key)
            print(f"finish: uploaded s3://{FINISHED_BUCKET}/{final_key}")

            # 6. stickers only: the cut sheet the GA operator opens in FineCut,
            # next to the TIF and named like it (sticker_sheet.py).
            if sticker:
                sheet = os.path.join(scratch, f"{item_no}.eps")
                laid = make_sheet(work, item["sticker"].get("shape"), item.get("quantity", 1), sheet)
                sheet_key = f"{order_name}/{sheet_name(final_name)}"
                s3.upload_file(sheet, FINISHED_BUCKET, sheet_key)
                os.remove(sheet)
                produced.append(sheet_key)
                print(f"finish: uploaded s3://{FINISHED_BUCKET}/{sheet_key} {json.dumps(laid)}")

    record_step(order_name, "done", detail=json.dumps(produced))
    print(json.dumps({"orderName": order_name, "produced": produced}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        order = os.environ.get("ORDER_NAME", "unknown")
        print(f"finish failed for {order}: {exc}", file=sys.stderr)
        try:
            record_step(order, "failed", detail=str(exc))
        finally:
            sys.exit(1)
