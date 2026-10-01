"""Bounds on the artwork download — run with `npm run test:python`.

The HTTP fetch has never run against a real customer file. On Sunday it will,
on a Fargate task with nobody watching, against servers we do not control. What
these pin is not the happy path but the three ways an unbounded download ruins
a processing window: a server that goes silent, one that streams forever, and
one that drops a connection that a retry would have carried.

No network and no real waiting: the opener, the clock and the sleep are all
injected.
"""

import os
import sys
import tempfile
import unittest
import urllib.error

sys.path.insert(0, os.path.join(
    os.path.dirname(__file__), '..', '..', 'src', 'services', 'resize'))

from fetch import (  # noqa: E402
    ArtworkTimeout, ArtworkTooLarge, download, is_retryable,
)


class FakeResponse:
    """Yields the given chunks, then EOF. Records that it was closed."""

    def __init__(self, chunks):
        self._chunks = list(chunks)
        self.closed = False

    def read(self, _n):
        return self._chunks.pop(0) if self._chunks else b''

    def close(self):
        self.closed = True


class EndlessResponse:
    """Never stops sending. The shape that fills a disk."""

    def read(self, n):
        return b'x' * n

    def close(self):
        pass


def opener_for(*responses):
    """An opener that returns each response in turn, recording the call count."""
    calls = {'n': 0}

    def _open(_url, timeout=None):  # noqa: ARG001 - signature must match urlopen
        calls['n'] += 1
        item = responses[min(calls['n'], len(responses)) - 1]
        if isinstance(item, Exception):
            raise item
        return item

    _open.calls = calls
    return _open


class ArtworkFetchTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.dest = os.path.join(self.dir.name, 'art.tif')
        self.addCleanup(self.dir.cleanup)

    def test_writes_the_file_and_reports_its_size(self):
        res = FakeResponse([b'abc', b'de'])
        n = download('http://x/art.tif', self.dest, env={},
                     opener=opener_for(res))
        self.assertEqual(n, 5)
        with open(self.dest, 'rb') as f:
            self.assertEqual(f.read(), b'abcde')
        self.assertTrue(res.closed, 'the response must be closed')

    def test_endless_stream_is_cut_off_at_the_byte_cap(self):
        # Without the cap this call does not return until the disk is full.
        with self.assertRaises(ArtworkTooLarge):
            download('http://x/art.tif', self.dest,
                     env={'ARTWORK_MAX_BYTES': '4194304'},
                     opener=opener_for(EndlessResponse()))

    def test_a_trickling_server_is_cut_off_at_the_deadline(self):
        # Each chunk is tiny but arrives, so the per-read socket timeout never
        # fires; only the wall clock catches this one.
        clock = iter([0, 1, 2, 999])
        with self.assertRaises(ArtworkTimeout):
            download('http://x/art.tif', self.dest,
                     env={'ARTWORK_DEADLINE_SECONDS': '600'},
                     opener=opener_for(EndlessResponse()),
                     monotonic=lambda: next(clock))

    def test_a_dropped_connection_is_retried(self):
        slept = []
        opener = opener_for(ConnectionResetError('reset'), FakeResponse([b'ok']))
        n = download('http://x/art.tif', self.dest, env={}, opener=opener,
                     sleep=slept.append)
        self.assertEqual(n, 2)
        self.assertEqual(opener.calls['n'], 2)
        self.assertEqual(slept, [2], 'first retry backs off 2s')

    def test_gives_up_after_the_attempt_budget(self):
        opener = opener_for(ConnectionResetError('reset'))
        with self.assertRaises(ConnectionResetError):
            download('http://x/art.tif', self.dest,
                     env={'ARTWORK_ATTEMPTS': '3'}, opener=opener,
                     sleep=lambda _s: None)
        self.assertEqual(opener.calls['n'], 3)

    def test_a_dead_link_fails_immediately_rather_than_retrying(self):
        # 404 means the link is wrong, not unlucky. Retrying just delays the
        # order reaching a human.
        gone = urllib.error.HTTPError('http://x', 404, 'Not Found', {}, None)
        opener = opener_for(gone)
        with self.assertRaises(urllib.error.HTTPError):
            download('http://x/art.tif', self.dest, env={}, opener=opener,
                     sleep=lambda _s: None)
        self.assertEqual(opener.calls['n'], 1)

    def test_retry_policy(self):
        self.assertTrue(is_retryable(ConnectionResetError()))
        self.assertTrue(is_retryable(TimeoutError()))
        self.assertTrue(is_retryable(
            urllib.error.HTTPError('http://x', 503, 'busy', {}, None)))
        self.assertTrue(is_retryable(
            urllib.error.HTTPError('http://x', 429, 'slow down', {}, None)))
        self.assertFalse(is_retryable(
            urllib.error.HTTPError('http://x', 403, 'Forbidden', {}, None)))
        self.assertFalse(is_retryable(ArtworkTooLarge()))
        self.assertFalse(is_retryable(ArtworkTimeout()),
                         'a spent deadline must not buy another one')

    def test_a_malformed_env_value_falls_back_instead_of_crashing(self):
        # A typo in a task definition must not take the service down.
        n = download('http://x/art.tif', self.dest,
                     env={'ARTWORK_MAX_BYTES': 'lots', 'ARTWORK_ATTEMPTS': '0'},
                     opener=opener_for(FakeResponse([b'abc'])))
        self.assertEqual(n, 3)


if __name__ == '__main__':
    unittest.main()
