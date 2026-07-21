"""Transfer service entrypoint (ECS Fargate, run-to-completion).

I. Facility transfer — ported from legacy ftpWorker.py /stp:
  - facility must be one of GA/NJ/TX/NV/CA
  - GA/NJ/TX/NV -> FTP upload of the finished folder to /{facility}/{orderId}
  - CA          -> Google Drive (service account, CA_DRIVE_ID parent)
  - before transfer: optional proof rename (renameDict) + invoice proof jpgs
    uploaded to FTP /proof

Plumbing changes only: files come from the finished S3 bucket instead of the
local disk; FTP/Drive credentials come from SSM Parameter Store
(/sb/<env>/ftp/*, /sb/<env>/google/*) instead of .env / a checked-in JSON.
Consumes messages the pipeline puts on ftp.fifo (SendToTransfer) or direct
ORDER_NAME + JOB env when run via Step Functions.
"""

import json
import os
import sys
import tempfile

import boto3
import ftputil

from drive_helper import get_drive, upload_print_folder

FACILITIES = ["GA", "NJ", "TX", "NV", "CA"]

s3 = boto3.client("s3")
ssm = boto3.client("ssm")
ddb = boto3.resource("dynamodb")

FINISHED_BUCKET = os.environ["FINISHED_BUCKET"]
JOBS_TABLE = os.environ.get("JOBS_TABLE", "")
SB_ENV = os.environ.get("SB_ENV", "dev")


def get_secret(group, key):
    name = f"/sb/{SB_ENV}/{group}/{key}"
    return ssm.get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]


def download_finished(order_name, dest_dir):
    """Pull finished/{order}/* from S3 into a local folder named {order}."""
    local_dir = os.path.join(dest_dir, order_name)
    os.makedirs(local_dir, exist_ok=True)
    paginator = s3.get_paginator("list_objects_v2")
    count = 0
    for page in paginator.paginate(Bucket=FINISHED_BUCKET, Prefix=f"{order_name}/"):
        for obj in page.get("Contents", []):
            fname = obj["Key"].split("/", 1)[1]
            if not fname:
                continue
            s3.download_file(FINISHED_BUCKET, obj["Key"], os.path.join(local_dir, fname))
            count += 1
    if count == 0:
        raise RuntimeError(f"No finished files found for order {order_name}")
    return local_dir


def rename_proof(local_dir, rename_dict):
    """Legacy rename_proof: {old}.jpg -> {new}.jpg inside the order folder."""
    results = []
    for old, new in (rename_dict or {}).items():
        old_path = os.path.join(local_dir, f"{old}.jpg")
        new_path = os.path.join(local_dir, f"{new}.jpg")
        if not os.path.exists(old_path):
            results.append({"old": old, "new": new, "success": False, "error": "not found"})
            continue
        if os.path.exists(new_path):
            results.append({"old": old, "new": new, "success": False, "error": "target exists"})
            continue
        os.rename(old_path, new_path)
        results.append({"old": old, "new": new, "success": True})
    return results


def upload_folder_ftp(local_dir, remote_dir, host, user, passwd):
    """Legacy upload_folder: recursive FTP upload preserving structure."""
    with ftputil.FTPHost(host, user, passwd) as ftp_host:
        if not ftp_host.path.exists(remote_dir):
            ftp_host.makedirs(remote_dir)
        for root, _dirs, files in os.walk(local_dir):
            rel = os.path.relpath(root, local_dir)
            ftp_path = ftp_host.path.join(remote_dir, rel) if rel != "." else remote_dir
            if not ftp_host.path.exists(ftp_path):
                ftp_host.makedirs(ftp_path)
            for fname in files:
                ftp_host.upload(os.path.join(root, fname), ftp_host.path.join(ftp_path, fname))


def upload_invoice_images(local_dir, image_names, host, user, passwd):
    """Legacy upload_invoice_image: proof jpgs -> FTP /proof."""
    with ftputil.FTPHost(host, user, passwd) as ftp_host:
        for image in image_names:
            local = os.path.join(local_dir, f"{image}.jpg")
            if os.path.exists(local):
                ftp_host.upload(local, ftp_host.path.join("/proof", f"{image}.jpg"))


def record_step(order_name, state, detail=""):
    if not JOBS_TABLE:
        return
    ddb.Table(JOBS_TABLE).put_item(Item={
        "PK": f"ORDER#{order_name}",
        "SK": "STEP#transfer",
        "state": state,
        "detail": detail,
    })


def main():
    order_name = os.environ["ORDER_NAME"]
    job = json.loads(os.environ["JOB"])
    facility = (job.get("routing") or {}).get("facility")
    if facility not in FACILITIES:
        raise ValueError(f"Invalid production facility: {facility}")

    rename_dict = job.get("renameDict") or {}

    with tempfile.TemporaryDirectory() as scratch:
        local_dir = download_finished(order_name, scratch)
        rename_results = rename_proof(local_dir, rename_dict)

        if facility == "CA":
            sa_json = get_secret("google", "service-account-json")
            ca_drive_id = get_secret("google", "ca-drive-id")
            sa_path = os.path.join(scratch, "service_account.json")
            with open(sa_path, "w") as f:
                f.write(sa_json)
            drive = get_drive(sa_path)
            result = upload_print_folder(drive, local_dir, ca_drive_id, max_workers=4)
            if result["failed"]:
                raise RuntimeError(f"CA Drive upload incomplete: {result}")
            detail = f"CA Drive folder {result['folder_id']} ({result['successful']} files)"
        else:
            host = get_secret("ftp", "host")
            user = get_secret("ftp", "user")
            passwd = get_secret("ftp", "password")
            invoice_images = list(rename_dict.values())
            upload_invoice_images(local_dir, invoice_images, host, user, passwd)
            upload_folder_ftp(local_dir, f"/{facility}/{order_name}", host, user, passwd)
            detail = f"FTP /{facility}/{order_name}"

    record_step(order_name, "done", detail=detail)
    print(json.dumps({"orderName": order_name, "facility": facility,
                      "detail": detail, "renames": rename_results}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        order = os.environ.get("ORDER_NAME", "unknown")
        print(f"transfer failed for {order}: {exc}", file=sys.stderr)
        try:
            record_step(order, "failed", detail=str(exc))
        finally:
            sys.exit(1)
