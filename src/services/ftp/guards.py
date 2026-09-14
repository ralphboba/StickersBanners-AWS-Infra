"""The two checks that decide whether a real production transfer happens.

Kept free of boto3 (and of every other import) so they can be unit-tested
without AWS. main.py cannot be imported in a test environment -- it builds S3
and DynamoDB clients at module load -- and these are the last thing that should
go unverified: this service is the only code in the project that puts print
files in front of the production team.

The two are independent on purpose:

  is_demo_order   synthetic DEMO-*/ZZ-* orders never transfer, whatever any
                  switch says.
  transfers_enabled  the real orders' hold. Off unless deliberately armed.

remote_path lives here for the same reason: where a print file lands is the
other half of "does production see this", and it has to be checkable without
an FTP server.
"""

import os


def is_demo_order(name):
    """Synthetic demo/test orders (DEMO-*, ZZ-*) never touch real FTP/Drive."""
    return isinstance(name, str) and name.upper().startswith(("DEMO-", "ZZ-"))


def transfers_enabled(env=None):
    """Is the real production upload switched on? Defaults to OFF.

    Deliberately an exact match on "enabled" so a stray truthy value ("0",
    "false", "no") cannot arm it by accident -- the same rule as
    ORDERDESK_WRITES and ZENDESK_SENDS.

    `env` is injectable for tests; it defaults to the process environment.
    """
    if env is None:
        import os
        env = os.environ
    return str(env.get("PRODUCTION_TRANSFER", "")).strip().lower() == "enabled"


# Prefix put in front of every remote path, for a trial run that must not drop
# files where production picks them up. Empty (the default) is the real layout:
# /GA/S59911 and /Proof/569315285.jpg. Set to "/AWS-TEST" and the same run
# writes /AWS-TEST/GA/S59911 and /AWS-TEST/Proof/569315285.jpg instead, which a
# person can inspect and then move across by hand once the files look right.
#
# A prefix is a setting rather than an edit to the paths because ending the
# trial has to be removing one variable. Leading/trailing slashes are tolerated
# so "/AWS-TEST/", "AWS-TEST" and "/AWS-TEST" all mean the same thing.
def ftp_base_path(env=None):
    raw = (env or os.environ).get("FTP_BASE_PATH", "").strip().strip("/")
    return f"/{raw}" if raw else ""


def remote_path(*parts, env=None):
    """Join a remote path under the (possibly empty) trial prefix."""
    tail = "/".join(str(p).strip("/") for p in parts if str(p).strip("/"))
    return f"{ftp_base_path(env)}/{tail}"


# How each facility's print files travel. A facility that is not here has no
# transport and must never be guessed at.
TRANSPORTS = {
    "GA": "ftp",
    "NJ": "ftp",
    "TX": "ftp",
    "NV": "ftp",
    "CA": "drive",
}

FACILITIES = tuple(TRANSPORTS)

# Transports the review path can actually divert.
#
# FTP can: every remote path is built through remote_path(), so FTP_BASE_PATH
# reaches all of them. Drive cannot: it uploads into a parent folder id read
# from SSM, and there is no prefix to apply.
#
# Deliberately a whitelist. Review mode used to be decided inside each
# transport, so Drive simply never asked the question and S59977 put six print
# files in the folder the CA facility collects from while every other facility
# that hour was correctly diverted. With a whitelist, a transport added later is
# undivertible until somebody says otherwise -- so the cost of forgetting is a
# held order, not a file in front of production.
DIVERTIBLE = frozenset({"ftp"})


def review_mode(env=None):
    """Is output being diverted so a person sees it before production does?

    Setting a path prefix at all is the choice: it exists only to send a run
    somewhere a person reviews.
    """
    return bool(ftp_base_path(env))


def transfer_destination(facility, order_name, env=None):
    """Where this order's print files go, and how -- decided in one place.

    Returns one of:
      {"kind": "ftp",   "path": ..., "review": bool}
      {"kind": "drive", "review": False}
      {"kind": "hold",  "reason": ...}

    The point of routing every transport through here is the default: in review
    mode a transport that cannot be diverted is HELD, never sent to the real
    destination.
    """
    transport = TRANSPORTS.get(facility)
    if transport is None:
        raise ValueError(f"Invalid production facility: {facility}")

    reviewing = review_mode(env)
    if reviewing and transport not in DIVERTIBLE:
        return {
            "kind": "hold",
            "reason": (f"review path cannot divert {transport} - "
                       f"{facility} would have gone to the real destination"),
        }

    if transport == "ftp":
        return {
            "kind": "ftp",
            "path": remote_path(facility, order_name, env=env),
            "review": reviewing,
        }
    return {"kind": "drive", "review": False}
