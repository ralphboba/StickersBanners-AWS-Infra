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

import boto3

from jobload import load_job

from converter import check_pdf_pages, get_dimensions, infer_unit, process_image
from artwork import artwork_extension, corrected_extension
from fetch import download
from orientation import orientation_mismatch, source_size, swap_action


class HeldForReview(RuntimeError):
    """Stop this order before anything is printed; a person decides next.

    Carries the hold reason and the structured detail the dashboard shows.
    """

    def __init__(self, reason, explain, detail=None):
        super().__init__(explain)
        self.reason = reason
        self.explain = explain
        self.detail = detail or []


class UnusableArtwork(RuntimeError):
    """The customer's file is not something the workers can print.

    Separated from every other failure because the answer is different. A timeout
    or an OOM is ours to fix and worth retrying; a two-page PDF is the customer's
    to resend, and no number of retries changes it. Legacy rejects these the same
    way (imageWorker.py:156) -- what it does not do is tell anyone, and neither
    did we: S61790 on 2026-09-19 simply became a failed execution nobody was
    going to look at.
    """

s3 = boto3.client("s3")
ddb = boto3.resource("dynamodb")

PROCESSED_BUCKET = os.environ["PROCESSED_BUCKET"]
UPLOADS_BUCKET = os.environ.get("UPLOADS_BUCKET", "")
JOBS_TABLE = os.environ.get("JOBS_TABLE", "")


def fetch_artwork(item, dest_dir, name):
    """Download the artwork to local scratch. URL (legacy path) or s3:// key."""
    url = item.get("artworkUrl") or ""
    ext = artwork_extension(item, url)
    local = os.path.join(dest_dir, f"{name}.{ext}")

    if url.startswith("s3://") or (UPLOADS_BUCKET and not url.startswith("http")):
        bucket = UPLOADS_BUCKET
        key = url.replace("s3://", "").split("/", 1)[-1] if url.startswith("s3://") else url
        s3.download_file(bucket, key, local)
    else:
        # Somebody else's server. Bounded in time and size, and retried — see
        # fetch.py for why the bare urlretrieve this replaces was a hazard.
        size = download(url, local)
        print(f"resize: fetched {size} bytes for {name} from {url.split('?')[0]}")

    if not os.path.exists(local) or os.path.getsize(local) == 0:
        raise RuntimeError(f"Cannot verify downloaded file for {name}")
    # Trust the bytes over the name (artwork.corrected_extension). The local
    # file is renamed so every later step -- page check, converter, orientation
    # -- sees the format it really is.
    real = corrected_extension(ext, local)
    if real != ext:
        fixed = os.path.join(dest_dir, f"{name}.{real}")
        os.replace(local, fixed)
        print(f"resize: {name} is named .{ext} but is a {real} file; processing it as {real}")
        local, ext = fixed, real
    if ext == "pdf":  # legacy: single-page PDFs only
        pages = check_pdf_pages(local)
        if pages != 1:
            raise UnusableArtwork(
                f"PDF for item {name} has {pages} pages; only single-page PDFs "
                "can be printed. The customer needs to resend one page.")
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


def item_size(item):
    """(width, height, unit) as ordered -- the numbers resize prints at."""
    width = item.get("width", item.get("widthFt"))
    height = item.get("height", item.get("heightFt"))
    unit = item.get("unit") or infer_unit(width, height, item.get("sku", ""))
    return width, height, unit


def swapped_items(fetched):
    """Items whose file is the other way round from the order.

    `fetched` is [(item, item_no, local_path)]. An item staff already decided
    on (orientationChecked, set by the dashboard) is never asked about again.
    """
    found = []
    for item, item_no, local in fetched:
        if item.get("orientationChecked"):
            continue
        width, height, unit = item_size(item)
        try:
            out_w, out_h = get_dimensions(width, height, unit)
        except (TypeError, ValueError):
            continue
        size = source_size(local, os.path.splitext(local)[1].lstrip("."))
        if not size:
            continue
        miss = orientation_mismatch(size[0], size[1], out_w, out_h)
        if miss:
            found.append({
                "itemNo": item_no,
                "name": item.get("name") or item.get("sku") or "",
                "ordered": f"{width} x {height} {unit}",
                "swapped": f"{height} x {width} {unit}",
                "fileSize": [int(round(size[0])), int(round(size[1]))],
                "file": miss["file"],
                "stretchAsOrdered": str(miss["stretchAsOrdered"]),
                "stretchIfSwapped": str(miss["stretchIfSwapped"]),
                # A pocket or grommet layout is laid out per side; whether it
                # turns with the banner is the customer's call, not a button.
                "hasPockets": bool((item.get("finishingObj") or {}).get("specialFinishing")),
            })
    return found


def main():
    order_name = os.environ["ORDER_NAME"]
    set_stage(order_name, "resizing")
    job = load_job(order_name)
    items = job.get("items", [])
    produced = []

    with tempfile.TemporaryDirectory() as scratch:
        # Fetch everything first, so the whole order is checked before any of
        # it is printed: a swapped item 3 must not leave items 1-2 half done.
        fetched = []
        for i, item in enumerate(items, start=1):
            # Use the itemNo the intake assigned BEFORE hardware lines were
            # dropped. Renumbering here would shift every file after a removed
            # stand — legacy numbers with index+1 and only then filters.
            item_no = item.get("itemNo", i)
            name = f"{item_no}-1"  # legacy naming: {item}-{file}
            fetched.append((item, item_no, fetch_artwork(item, scratch, name)))

        swapped = swapped_items(fetched)
        action = swap_action(bool(job.get("needsProof")), swapped)
        if action:
            lines = [f"Item {s['itemNo']}: the file is {s['file']} "
                     f"({s['fileSize'][0]}x{s['fileSize'][1]}) but the order is "
                     f"{s['ordered']}; {s['swapped']} would fit it."
                     for s in swapped]
            if action == "hold":
                raise HeldForReview("size-swapped", " ".join(lines), swapped)
            # Proof order: printed as ordered, proofed as usual, flagged.
            note_size_swap(order_name, " ".join(lines), swapped)

        for item, item_no, local in fetched:
            name = f"{item_no}-1"
            output = os.path.join(scratch, f"{name}v1.tif")
            width, height, unit = item_size(item)
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


def note_size_swap(order_name, explain, items):
    """Flag a proof order whose file looks swapped, without stopping it.

    Sets META.sizeSwap; the dashboard shows it on the order in Proofing. The
    status is untouched -- the order carries on to its proof. Never raises: a
    note that could not be written must not cost the customer their proof.
    """
    print(json.dumps({"orderName": order_name, "sizeSwapNote": explain}))
    if not JOBS_TABLE:
        return
    try:
        ddb.Table(JOBS_TABLE).update_item(
            Key={"PK": f"ORDER#{order_name}", "SK": "META"},
            UpdateExpression="SET sizeSwap = :n",
            ExpressionAttributeValues={":n": {"explain": explain, "items": items}},
        )
    except Exception as err:
        print(f"resize: could not note size swap on {order_name}: {err}", file=sys.stderr)


def hold_for_review(order_name, reason, explain, detail=None):
    """Park the order in needs_review, the same shape the intake gate writes.

    The gate can only catch what is visible in the order record; whether a PDF
    has one page or two is visible only once the file is on disk, which is here.
    So the same verdict gets written from a different place, and the order shows
    up in the manual folder with a reason instead of in the failure pile with a
    stack trace. Cosmetic failures here must not mask the real error, so this
    never raises.
    """
    if not JOBS_TABLE:
        return
    try:
        ddb.Table(JOBS_TABLE).update_item(
            Key={"PK": f"ORDER#{order_name}", "SK": "META"},
            UpdateExpression=(
                "SET #gp = :status, #s = :statusName, #st = :stage, #h = :hold"),
            ExpressionAttributeNames={
                "#gp": "GSI1PK", "#s": "status", "#st": "stage", "#h": "hold"},
            ExpressionAttributeValues={
                ":status": "STATUS#needs_review",
                ":statusName": "needs_review",
                ":stage": "held",
                ":hold": {"reason": reason, "explain": explain, "source": "resize",
                          **({"items": detail} if detail else {})},
            },
        )
        print(json.dumps({"orderName": order_name, "held": reason,
                          "explain": explain}))
    except Exception as err:
        print(f"resize: could not hold {order_name}: {err}", file=sys.stderr)


if __name__ == "__main__":
    # A hold exits 0. It used to exit 1, which Step Functions retried three
    # times and then caught with MarkFailed -- overwriting needs_review with
    # "failed" and losing the reason (S61790, 2026-09-19, is "failed" today).
    # The workflow now reads the status after this step and stops cleanly when
    # the order is held (workflow-stack CheckHeld).
    try:
        main()
    except HeldForReview as exc:
        order = os.environ.get("ORDER_NAME", "unknown")
        print(f"resize: holding {order} ({exc.reason}): {exc.explain}", file=sys.stderr)
        record_step(order, "held", detail=exc.explain)
        hold_for_review(order, exc.reason, exc.explain, exc.detail)
        sys.exit(0)
    except UnusableArtwork as exc:
        # Not our bug and not a transient one: a person has to go back to the
        # customer. Record it as a hold so it lands where staff already look.
        order = os.environ.get("ORDER_NAME", "unknown")
        print(f"resize: unusable artwork for {order}: {exc}", file=sys.stderr)
        record_step(order, "held", detail=str(exc))
        hold_for_review(order, "bad-artwork", str(exc))
        sys.exit(0)
    except Exception as exc:  # mark failure for the pipeline, then fail the task
        order = os.environ.get("ORDER_NAME", "unknown")
        print(f"resize failed for {order}: {exc}", file=sys.stderr)
        try:
            record_step(order, "failed", detail=str(exc))
        finally:
            sys.exit(1)
