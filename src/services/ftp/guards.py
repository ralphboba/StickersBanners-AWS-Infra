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
"""


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
