"""Read-only inspection of the facility FTP — Linh's real output, for comparison.

Why this exists: finish/proof were ported by READING Linh's source, and pinned
with tests that assert the rules his code implements. Nothing has ever been
compared against a file his program actually produced. But his program uploads
every print folder to /{facility}/{orderName} and every invoice proof jpg to
/proof — the same FTP our transfer step writes to. The reference output is
already sitting there; it only had to be fetched.

This module only ever READS. Every mutating method on the connected host is
replaced with a raise BEFORE any path is touched (`make_read_only`), so a bug in
the walk cannot create, overwrite, rename or delete anything in a live facility
folder. Same reasoning as guards.py: the safety belongs in the code, not in the
care of whoever runs it.

Run contract (env), all optional except the bucket:

  FTP_INSPECT_PATHS      comma-separated remote dirs to list   (default "/")
  FTP_INSPECT_DEPTH      how deep to recurse under each        (default 1)
  FTP_INSPECT_GET        comma-separated remote FILES to fetch (default none)
  FTP_INSPECT_NEWEST     also fetch the N newest files per listed dir (default 0)
  FTP_INSPECT_BUCKET     S3 bucket for the manifest + fetched files
  FTP_INSPECT_PREFIX     S3 key prefix                         (default "_linh-compare")
  FTP_INSPECT_MAX_BYTES  per-file size cap                     (default 256 MiB)
  FTP_INSPECT_MAX_FILES  total files to fetch                  (default 20)
  FTP_INSPECT_MAX_ENTRIES  entries listed per directory         (default 200)

The manifest (always written) is the listing itself: path, size, mtime, isdir.
That alone answers "what does his output look like" for naming and structure;
the fetched files answer it for pixels.
"""

import json
import os
import posixpath
import sys
import tempfile

DEFAULT_MAX_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_FILES = 20
DEFAULT_MAX_ENTRIES = 200
CHUNK_BYTES = 1024 * 1024

# Everything ftputil exposes that can change the remote side. Listed explicitly
# rather than guessed at by name, so a new ftputil release cannot quietly add a
# writer that slips through a pattern match.
MUTATORS = (
    'upload', 'upload_if_newer', 'makedirs', 'mkdir', 'remove', 'unlink',
    'rmdir', 'rmtree', 'rename', 'chmod', 'copyfileobj', 'utime',
)


class WriteAttempted(RuntimeError):
    """A mutating FTP call was made on a host opened for inspection."""


class FileTooLarge(RuntimeError):
    """A remote file exceeded the per-file byte cap."""


def make_read_only(host):
    """Neuter every mutating method on a connected FTPHost, in place.

    Returns the same host so it can be used inline. Call this immediately after
    connecting and before touching any path.
    """
    for name in MUTATORS:
        if not hasattr(host, name):
            continue

        def refuse(*_args, _name=name, **_kwargs):
            raise WriteAttempted(
                f'{_name}() called on a read-only inspection host — '
                'this tool never writes to the facility FTP')

        setattr(host, name, refuse)
    return host


def walk(host, path, depth, out=None, max_entries=DEFAULT_MAX_ENTRIES):
    """Collect {path,size,mtime,isdir} for everything under path, depth-limited.

    Every entry costs an isdir() and a stat() — two round trips. A facility
    folder holds years of orders, so an uncapped walk is hours of them. Past the
    cap we keep the LAST names in sort order, which for order folders (S59881,
    S59882, …) and dated proof jpgs means the most recent ones, and record what
    was left out rather than silently truncating.
    """
    if out is None:
        out = []
    try:
        names = sorted(host.listdir(path))
    except Exception as err:  # an unreadable dir should not kill the whole run
        out.append({'path': path, 'error': str(err)})
        return out

    if max_entries and len(names) > max_entries:
        out.append({'path': path, 'truncated': True,
                    'total': len(names), 'listed': max_entries})
        names = names[-max_entries:]

    for name in names:
        full = posixpath.join(path, name)
        try:
            is_dir = host.path.isdir(full)
            stat = host.stat(full)
            entry = {'path': full, 'isdir': is_dir,
                     'size': stat.st_size, 'mtime': int(stat.st_mtime)}
        except Exception as err:
            out.append({'path': full, 'error': str(err)})
            continue
        out.append(entry)
        if is_dir and depth > 1:
            walk(host, full, depth - 1, out, max_entries)
    return out


def fetch(host, remote, dest_path, max_bytes=DEFAULT_MAX_BYTES):
    """Stream one remote file down, refusing anything over the cap.

    Chunked rather than host.download() so the cap is enforced by what actually
    arrives, not by what the server claimed in stat().
    """
    written = 0
    with host.open(remote, 'rb') as src, open(dest_path, 'wb') as dst:
        while True:
            chunk = src.read(CHUNK_BYTES)
            if not chunk:
                break
            written += len(chunk)
            if written > max_bytes:
                raise FileTooLarge(f'{remote} exceeded {max_bytes} bytes')
            dst.write(chunk)
    return written


def newest_files(entries, count):
    """The N most recently modified plain files in a listing."""
    files = [e for e in entries if not e.get('isdir') and 'mtime' in e]
    files.sort(key=lambda e: e['mtime'], reverse=True)
    return [e['path'] for e in files[:count]]


def _env_int(name, default):
    raw = os.environ.get(name, '').strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value >= 0 else default


def _csv(name):
    return [p.strip() for p in os.environ.get(name, '').split(',') if p.strip()]


def main():
    import boto3
    import ftputil

    bucket = os.environ['FTP_INSPECT_BUCKET']
    prefix = os.environ.get('FTP_INSPECT_PREFIX', '_linh-compare').strip('/')
    paths = _csv('FTP_INSPECT_PATHS') or ['/']
    depth = _env_int('FTP_INSPECT_DEPTH', 1)
    wanted = _csv('FTP_INSPECT_GET')
    newest = _env_int('FTP_INSPECT_NEWEST', 0)
    max_bytes = _env_int('FTP_INSPECT_MAX_BYTES', DEFAULT_MAX_BYTES)
    max_files = _env_int('FTP_INSPECT_MAX_FILES', DEFAULT_MAX_FILES)
    max_entries = _env_int('FTP_INSPECT_MAX_ENTRIES', DEFAULT_MAX_ENTRIES)

    sb_env = os.environ.get('SB_ENV', 'dev')
    ssm = boto3.client('ssm')

    def secret(key):
        name = f'/sb/{sb_env}/ftp/{key}'
        return ssm.get_parameter(Name=name, WithDecryption=True)['Parameter']['Value']

    s3 = boto3.client('s3')
    manifest = {'paths': {}, 'fetched': [], 'skipped': []}

    with ftputil.FTPHost(secret('host'), secret('user'), secret('password')) as host:
        make_read_only(host)

        for path in paths:
            entries = walk(host, path, depth, max_entries=max_entries)
            manifest['paths'][path] = entries
            print(f'inspect: {path} -> {len(entries)} entries')
            if newest:
                wanted.extend(newest_files(entries, newest))

        # De-duplicate while keeping the order they were asked for.
        seen = set()
        queue = [p for p in wanted if not (p in seen or seen.add(p))][:max_files]

        with tempfile.TemporaryDirectory() as scratch:
            for remote in queue:
                local = os.path.join(scratch, posixpath.basename(remote))
                try:
                    size = fetch(host, remote, local, max_bytes)
                except Exception as err:
                    manifest['skipped'].append({'path': remote, 'error': str(err)})
                    print(f'inspect: SKIP {remote}: {err}', file=sys.stderr)
                    continue
                key = f'{prefix}/files/{remote.lstrip("/")}'
                s3.upload_file(local, bucket, key)
                manifest['fetched'].append({'path': remote, 'size': size, 's3': key})
                print(f'inspect: fetched {remote} ({size} bytes) -> s3://{bucket}/{key}')

    manifest_key = f'{prefix}/manifest.json'
    s3.put_object(Bucket=bucket, Key=manifest_key,
                  Body=json.dumps(manifest, indent=2).encode(),
                  ContentType='application/json')
    print(f'inspect: manifest -> s3://{bucket}/{manifest_key}')
    print(json.dumps({'listed': {p: len(e) for p, e in manifest['paths'].items()},
                      'fetched': len(manifest['fetched']),
                      'skipped': len(manifest['skipped'])}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'inspect failed: {exc}', file=sys.stderr)
        sys.exit(1)
