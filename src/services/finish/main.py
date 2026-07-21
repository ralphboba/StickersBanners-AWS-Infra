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

import json
import os
import shutil
import sys
import tempfile

import boto3
from PIL import Image

from finishing_config import build_finishing_obj
from grommets import GrommetsAdder
from pole_pockets import PolePocketsAdder

Image.MAX_IMAGE_PIXELS = None

s3 = boto3.client("s3")
ddb = boto3.resource("dynamodb")

PROCESSED_BUCKET = os.environ["PROCESSED_BUCKET"]
FINISHED_BUCKET = os.environ["FINISHED_BUCKET"]
JOBS_TABLE = os.environ.get("JOBS_TABLE", "")


def create_proof_file(source_path, proof_path):
    """Legacy createProofFile: 300px thumbnail jpg (CMYK converted to RGB)."""
    with Image.open(source_path) as img:
        if img.mode == "CMYK":
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


def main():
    order_name = os.environ["ORDER_NAME"]
    job = json.loads(os.environ["JOB"])
    items = job.get("items", [])
    grommet = GrommetsAdder()
    pockets = PolePocketsAdder()
    produced = []

    with tempfile.TemporaryDirectory() as scratch:
        for i, item in enumerate(items, start=1):
            item_no = f"{i}-1"
            src_key = f"{order_name}/{item_no}v1.tif"
            src = os.path.join(scratch, f"{item_no}v1.tif")
            s3.download_file(PROCESSED_BUCKET, src_key, src)

            finishing_obj = build_finishing_obj(item)
            work = os.path.join(scratch, f"{item_no}.tif")

            # 1. proof thumbnail
            proof = os.path.join(scratch, f"{item_no}.jpg")
            create_proof_file(src, proof)
            proof_key = f"{order_name}/{item_no}.jpg"
            s3.upload_file(proof, FINISHED_BUCKET, proof_key)

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
            desc = finishing_obj.get("descSuf", "")
            qty = int(finishing_obj.get("quantity", 1))
            if qty > 1:
                desc = f"{desc} qty {qty}".strip()
            final_name = f"{order_name}-{item_no} {desc}".rstrip() + ".tif"
            final_key = f"{order_name}/{final_name}"
            s3.upload_file(work, FINISHED_BUCKET, final_key)
            produced.append(final_key)
            print(f"finish: uploaded s3://{FINISHED_BUCKET}/{final_key}")

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
