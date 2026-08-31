"""Resize service entrypoint (ECS Fargate, run-to-completion).

Invoked by Step Functions (EcsRunTask .sync) with:
  ORDER_NAME  e.g. "S42307"
  JOB         the cleaned job JSON (see src/functions/webhook cleanOrder)

Per artwork file: download (URL or uploads bucket) -> convert/resize
(converter.py, legacy logic) -> upload TIFF to the processed bucket at
{orderName}/{itemNo}v1.tif -> record STEP#resize in DynamoDB.

Replaces the legacy imageWorker's local-disk/Redis plumbing with S3/DynamoDB;
the pixel logic itself is untouched (converter.py).
"""

import json
import os
import sys
import tempfile
import urllib.request

import boto3

from converter import check_pdf_pages, infer_unit, process_image

s3 = boto3.client("s3")
ddb = boto3.resource("dynamodb")

PROCESSED_BUCKET = os.environ["PROCESSED_BUCKET"]
UPLOADS_BUCKET = os.environ.get("UPLOADS_BUCKET", "")
JOBS_TABLE = os.environ.get("JOBS_TABLE", "")


def fetch_artwork(item, dest_dir, name):
    """Download the artwork to local scratch. URL (legacy path) or s3:// key."""
    url = item.get("artworkUrl") or ""
    ext = (os.path.splitext(url.split("?")[0])[1][1:] or "pdf").lower()
    local = os.path.join(dest_dir, f"{name}.{ext}")

    if url.startswith("s3://") or (UPLOADS_BUCKET and not url.startswith("http")):
        bucket = UPLOADS_BUCKET
        key = url.replace("s3://", "").split("/", 1)[-1] if url.startswith("s3://") else url
        s3.download_file(bucket, key, local)
    else:
        urllib.request.urlretrieve(url, local)

    if not os.path.exists(local) or os.path.getsize(local) == 0:
        raise RuntimeError(f"Cannot verify downloaded file for {name}")
    if ext == "pdf" and check_pdf_pages(local) != 1:  # legacy: single-page PDFs only
        raise RuntimeError(f"Invalid PDF (must be exactly 1 page): {name}")
    return local


def record_step(order_name, state, detail=""):
    if not JOBS_TABLE:
        return
    ddb.Table(JOBS_TABLE).put_item(Item={
        "PK": f"ORDER#{order_name}",
        "SK": "STEP#resize",
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


def main():
    order_name = os.environ["ORDER_NAME"]
    set_stage(order_name, "resizing")
    job = json.loads(os.environ["JOB"])
    items = job.get("items", [])
    produced = []

    with tempfile.TemporaryDirectory() as scratch:
        for i, item in enumerate(items, start=1):
            name = f"{i}-1"  # legacy naming: {item}-{file}
            local = fetch_artwork(item, scratch, name)
            output = os.path.join(scratch, f"{name}v1.tif")

            width = item.get("width", item.get("widthFt"))
            height = item.get("height", item.get("heightFt"))
            unit = item.get("unit") or infer_unit(width, height, item.get("sku", ""))
            process_image(
                file_path=local,
                width=width,
                height=height,
                unit=unit,
                output_path=output,
            )

            key = f"{order_name}/{name}v1.tif"
            s3.upload_file(output, PROCESSED_BUCKET, key)
            produced.append(key)
            print(f"resize: uploaded s3://{PROCESSED_BUCKET}/{key}")

    record_step(order_name, "done", detail=json.dumps(produced))
    print(json.dumps({"orderName": order_name, "produced": produced}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # mark failure for the pipeline, then fail the task
        order = os.environ.get("ORDER_NAME", "unknown")
        print(f"resize failed for {order}: {exc}", file=sys.stderr)
        try:
            record_step(order, "failed", detail=str(exc))
        finally:
            sys.exit(1)
