"""Where a container gets the job it is supposed to work on.

Step Functions used to pass the whole cleaned job as the JOB container
override. ECS caps container overrides at 8192 bytes, and S59976 -- a real
order with 19 line items -- serialized to 16,004, so the task could not even
start and the order failed all four retries during the 2026-09-13 window.
Ordinary orders run 1.5-3 KB, which is why this held for so long; roughly ten
line items is where it tips over.

The job is already in DynamoDB in full: the poller writes the whole cleaned job
onto the META row when it enqueues. So the fix is to read it there and pass only
the order name, which is bounded.

JOB is still honoured when present. That is deliberate: it makes the deploy
order not matter, so a new image running under the old workflow (or the reverse)
behaves identically either way.

Deliberately import-light: boto3 is imported inside the function that needs it,
not at module scope, so this can be unit tested without the image stack -- the
same reason guards.py and finishing_config.py exist.
"""

import json
import os
from decimal import Decimal


def plain(value):
    """DynamoDB numbers come back as Decimal; the pipeline does arithmetic.

    int(Decimal("3")) works, but json.dumps does not, and a Decimal width
    silently changes how sizes compare. Convert the whole tree once, on the way
    in, so nothing downstream has to know where the job came from.
    """
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, list):
        return [plain(v) for v in value]
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    return value


def load_job(order_name, table_name=None, env=None, resource=None):
    """The cleaned job for this order: the JOB override, else the META row."""
    env = os.environ if env is None else env

    raw = env.get("JOB")
    if raw:
        return json.loads(raw)

    table_name = table_name or env.get("JOBS_TABLE", "")
    if not table_name:
        raise RuntimeError(
            f"no JOB override and no JOBS_TABLE to read {order_name} from")

    if resource is None:
        import boto3  # deferred: see the module docstring
        resource = boto3.resource("dynamodb")
    ddb = resource
    item = ddb.Table(table_name).get_item(
        Key={"PK": f"ORDER#{order_name}", "SK": "META"}
    ).get("Item")
    if not item:
        raise RuntimeError(f"no META row for {order_name}")

    job = plain(item)
    # Row bookkeeping, not part of the job the legacy pipeline knows about.
    for key in ("PK", "SK", "GSI1PK", "GSI1SK", "mirror"):
        job.pop(key, None)
    return job
