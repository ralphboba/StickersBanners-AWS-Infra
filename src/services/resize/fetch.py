"""Fetching a customer's artwork over the network.

Split out of main.py, and kept free of boto3 and of every other third-party
import, so the failure modes can be unit-tested without AWS. The S3 path stays
in main.py; this module is only the HTTP one.

Why it exists at all: the HTTP path had never run against a real customer file.
Every run so far has been a DEMO order whose artwork is one synthetic image in
our own uploads bucket, fetched over the S3 endpoint. The first real order will
hand this code a URL on somebody else's server, and the previous implementation
was a bare

    urllib.request.urlretrieve(url, local)

with no timeout, no size limit and no retry. Three ways that ends badly, all of
them on a Fargate task with nobody watching:

  * a server that accepts the connection and then never sends anything holds
    the task open until the Step Functions timeout — minutes to hours of a
    processing window spent on one order;
  * a server that streams without end fills the container's disk;
  * a single dropped connection fails an order that a second attempt would
    have fetched.

So: a per-read timeout, a byte cap, a wall-clock deadline, and retries on
transient errors only. The defaults are deliberately loose — print artwork is
genuinely large and genuinely slow — because the job here is to stop a hang,
not to second-guess a legitimate file.
"""

import os
import time
import urllib.error
import urllib.request

#: Seconds a single socket read may block. Not a total budget: a slow but
#: progressing download resets it on every chunk, which is what we want for a
#: 400 MB TIFF on a bad link. It only fires when the far end goes silent.
DEFAULT_TIMEOUT_SECONDS = 60

#: Total wall clock for one attempt, covering the case the per-read timeout
#: cannot: a server that trickles a few bytes forever, resetting the read
#: timeout each time and never finishing.
DEFAULT_DEADLINE_SECONDS = 600

#: Hard ceiling on a downloaded file. Well above any real artwork we have seen;
#: this is here to stop an endless stream, not to reject big customer files.
DEFAULT_MAX_BYTES = 1024 * 1024 * 1024  # 1 GiB

#: Attempts in total, not retries after the first.
DEFAULT_ATTEMPTS = 3

#: Read granularity. Also how often the deadline and the byte cap are checked.
CHUNK_BYTES = 1024 * 1024


class ArtworkTooLarge(RuntimeError):
    """The download passed the byte cap and was abandoned."""


class ArtworkTimeout(RuntimeError):
    """The download passed the wall-clock deadline and was abandoned."""


def _setting(env, name, default):
    """Read a positive int from the environment, falling back to `default`.

    A malformed or non-positive value falls back rather than raising: a typo in
    a task definition should not take the service down, and the default is safe.
    """
    raw = (env or {}).get(name)
    if raw is None:
        return default
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def is_retryable(err):
    """Is this worth a second attempt?

    A 404/403 means the link is wrong or expired and will be wrong again in two
    seconds, so it fails immediately and the order goes to a human. Everything
    else network-shaped — a reset, a DNS blip, a 5xx, a socket timeout — gets
    retried.

    Our own two limits never are. ArtworkTooLarge would hit the same cap on the
    next attempt, and ArtworkTimeout has already spent a full deadline: retrying
    it would burn the budget two more times over for a server we already know is
    not delivering.
    """
    if isinstance(err, (ArtworkTooLarge, ArtworkTimeout)):
        return False
    if isinstance(err, urllib.error.HTTPError):
        return err.code >= 500 or err.code == 429
    return True


def download(url, dest_path, *, env=None, opener=None, sleep=time.sleep,
             monotonic=time.monotonic):
    """Download `url` to `dest_path`, bounded in time and size.

    `opener`, `sleep` and `monotonic` are injectable so the tests can exercise
    the timeout, cap and retry paths without a network or a real wait.

    Returns the number of bytes written. Raises the last error if every attempt
    fails; the caller turns that into a failed step for the order.
    """
    env = os.environ if env is None else env
    timeout = _setting(env, 'ARTWORK_TIMEOUT_SECONDS', DEFAULT_TIMEOUT_SECONDS)
    deadline = _setting(env, 'ARTWORK_DEADLINE_SECONDS', DEFAULT_DEADLINE_SECONDS)
    max_bytes = _setting(env, 'ARTWORK_MAX_BYTES', DEFAULT_MAX_BYTES)
    attempts = _setting(env, 'ARTWORK_ATTEMPTS', DEFAULT_ATTEMPTS)
    open_url = opener or urllib.request.urlopen

    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            return _attempt(url, dest_path, open_url, timeout, deadline,
                            max_bytes, monotonic)
        except Exception as err:  # noqa: BLE001 - re-raised below
            last_error = err
            if attempt == attempts or not is_retryable(err):
                raise
            # 2s, 4s, 8s … long enough for a blip to pass, short enough that
            # three attempts still fit inside a processing window.
            sleep(2 ** attempt)
    raise last_error  # unreachable; kept so the contract is explicit


def _attempt(url, dest_path, open_url, timeout, deadline, max_bytes, monotonic):
    started = monotonic()
    written = 0
    response = open_url(url, timeout=timeout)
    try:
        with open(dest_path, 'wb') as out:
            while True:
                chunk = response.read(CHUNK_BYTES)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    raise ArtworkTooLarge(
                        f'artwork exceeded {max_bytes} bytes: {url}')
                if monotonic() - started > deadline:
                    raise ArtworkTimeout(
                        f'artwork download exceeded {deadline}s: {url}')
                out.write(chunk)
    finally:
        close = getattr(response, 'close', None)
        if close:
            close()
    return written
