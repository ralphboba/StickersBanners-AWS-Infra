"""Proof service entrypoint (ECS Fargate, run-to-completion).

H. For each processed image: build the DZI deep-zoom pyramid + derivative
proof images (thumbnail/bleed/review), then upload the whole tree to the dzi
bucket, which CloudFront serves to the proof viewer (Week 11 CDN).

Run contract: ORDER_NAME + JOB env; reads processed/{order}/{itemNo}v1.tif,
writes dzi/{order}/... , records STEP#proof in DynamoDB.
"""

import json
import os
import sys
import tempfile

import boto3

from dzi import prepare_proof

s3 = boto3.client("s3")
ddb = boto3.resource("dynamodb")

PROCESSED_BUCKET = os.environ["PROCESSED_BUCKET"]
DZI_BUCKET = os.environ["DZI_BUCKET"]
JOBS_TABLE = os.environ.get("JOBS_TABLE", "")

CONTENT_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                 ".dzi": "application/xml", ".xml": "application/xml"}


def upload_tree(local_dir, bucket, prefix):
    """Upload every file under local_dir (the DZI pyramid + derivatives)."""
    count = 0
    for root, _dirs, files in os.walk(local_dir):
        for fname in files:
            local = os.path.join(root, fname)
            rel = os.path.relpath(local, local_dir)
            key = f"{prefix}/{rel.replace(os.sep, '/')}"
            ext = os.path.splitext(fname)[1].lower()
            extra = {"ContentType": CONTENT_TYPES[ext]} if ext in CONTENT_TYPES else {}
            s3.upload_file(local, bucket, key, ExtraArgs=extra)
            count += 1
    return count


def record_step(order_name, state, detail=""):
    if not JOBS_TABLE:
        return
    ddb.Table(JOBS_TABLE).put_item(Item={
        "PK": f"ORDER#{order_name}",
        "SK": "STEP#proof",
        "state": state,
        "detail": detail,
    })


def main():
    order_name = os.environ["ORDER_NAME"]
    job = json.loads(os.environ["JOB"])
    items = job.get("items", [])
    uploaded_total = 0

    with tempfile.TemporaryDirectory() as scratch:
        out_dir = os.path.join(scratch, "out")
        os.makedirs(out_dir, exist_ok=True)

        for i, _item in enumerate(items, start=1):
            name = f"{i}-1v1.tif"
            src = os.path.join(scratch, name)
            s3.download_file(PROCESSED_BUCKET, f"{order_name}/{name}", src)
            prepare_proof(src, out_dir, name)
            print(f"proof: generated DZI + derivatives for {name}")

        uploaded_total = upload_tree(out_dir, DZI_BUCKET, order_name)

    record_step(order_name, "done", detail=f"{uploaded_total} files")
    print(json.dumps({"orderName": order_name, "uploaded": uploaded_total}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        order = os.environ.get("ORDER_NAME", "unknown")
        print(f"proof failed for {order}: {exc}", file=sys.stderr)
        try:
            record_step(order, "failed", detail=str(exc))
        finally:
            sys.exit(1)
