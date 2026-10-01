"""FTP inspection tests — run with `npm run test:python`.

The thing worth pinning here is the *refusal*. This tool points at the live
facility FTP, the folder production prints from, so the guarantee that it cannot
write has to be enforced by the code and checked by a test — not left to whoever
writes the next walk loop. Everything else (listing, the byte cap, newest-first)
is checked against a fake host so no FTP is needed.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(
    os.path.dirname(__file__), '..', '..', 'src', 'services', 'ftp'))

from ftp_inspect import (  # noqa: E402
    FileTooLarge, MUTATORS, WriteAttempted, _env_int, fetch, make_read_only,
    newest_files, walk,
)


class FakeStat:
    def __init__(self, size, mtime):
        self.st_size = size
        self.st_mtime = mtime


class FakePath:
    def __init__(self, host):
        self.host = host

    def isdir(self, path):
        return path in self.host.tree


class FakeReader:
    def __init__(self, data, chunk):
        self.data = data
        self.chunk = chunk
        self.pos = 0

    def read(self, _n=None):
        out = self.data[self.pos:self.pos + self.chunk]
        self.pos += len(out)
        return out

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class FakeHost:
    """Just enough ftputil surface for the read paths, plus real mutators."""

    def __init__(self, tree=None, files=None, blobs=None):
        self.tree = tree or {}          # dir path -> [names]
        self.files = files or {}        # file path -> (size, mtime)
        self.blobs = blobs or {}        # file path -> bytes
        self.path = FakePath(self)
        self.writes = []

    def listdir(self, path):
        if path not in self.tree:
            raise OSError(f'no such directory: {path}')
        return self.tree[path]

    def stat(self, path):
        if path in self.tree:
            return FakeStat(0, 1)
        return FakeStat(*self.files[path])

    def open(self, path, _mode='rb'):
        return FakeReader(self.blobs[path], chunk=8)

    # Real mutators, so the test proves they were actually replaced.
    def upload(self, *_a, **_k):
        self.writes.append('upload')

    def remove(self, *_a, **_k):
        self.writes.append('remove')

    def rename(self, *_a, **_k):
        self.writes.append('rename')

    def makedirs(self, *_a, **_k):
        self.writes.append('makedirs')

    def rmtree(self, *_a, **_k):
        self.writes.append('rmtree')


class ReadOnlyGuard(unittest.TestCase):
    def test_every_mutator_raises_instead_of_writing(self):
        host = make_read_only(FakeHost())
        for name in ('upload', 'remove', 'rename', 'makedirs', 'rmtree'):
            with self.subTest(method=name):
                with self.assertRaises(WriteAttempted):
                    getattr(host, name)('/GA/S12345', 'whatever')
        self.assertEqual(host.writes, [], 'a mutating call reached the fake host')

    def test_the_refusal_names_the_method(self):
        host = make_read_only(FakeHost())
        with self.assertRaises(WriteAttempted) as caught:
            host.upload('a', 'b')
        self.assertIn('upload', str(caught.exception))

    def test_reads_still_work_after_neutering(self):
        host = make_read_only(FakeHost(tree={'/proof': ['a.jpg']},
                                      files={'/proof/a.jpg': (10, 5)}))
        self.assertEqual(host.listdir('/proof'), ['a.jpg'])

    def test_a_missing_mutator_is_not_an_error(self):
        # ftputil versions differ; absent names are skipped, not crashed on.
        class Bare:
            pass
        make_read_only(Bare())  # must not raise

    def test_the_mutator_list_covers_the_destructive_verbs(self):
        for verb in ('upload', 'remove', 'rmdir', 'rename', 'makedirs'):
            self.assertIn(verb, MUTATORS)


class Listing(unittest.TestCase):
    def setUp(self):
        self.host = FakeHost(
            tree={'/': ['GA', 'proof'],
                  '/GA': ['S59881'],
                  '/GA/S59881': ['1v1.tif'],
                  '/proof': ['old.jpg', 'new.jpg']},
            files={'/GA/S59881/1v1.tif': (4096, 100),
                   '/proof/old.jpg': (10, 100),
                   '/proof/new.jpg': (20, 999)})

    def test_depth_one_does_not_descend(self):
        entries = walk(self.host, '/', depth=1)
        self.assertEqual([e['path'] for e in entries], ['/GA', '/proof'])

    def test_depth_three_reaches_the_order_folder(self):
        paths = [e['path'] for e in walk(self.host, '/', depth=3)]
        self.assertIn('/GA/S59881', paths)
        self.assertIn('/GA/S59881/1v1.tif', paths)

    def test_an_unreadable_directory_is_recorded_not_fatal(self):
        entries = walk(FakeHost(tree={}), '/nope', depth=1)
        self.assertEqual(len(entries), 1)
        self.assertIn('error', entries[0])

    def test_a_huge_directory_is_capped_and_says_so(self):
        # A facility folder holds years of orders; each entry costs two round
        # trips, so the walk keeps the last names in sort order (the newest
        # order numbers) and records the total it skipped.
        names = [f'S{n}' for n in range(59000, 59500)]
        host = FakeHost(tree={'/GA': names},
                        files={f'/GA/{n}': (1, 1) for n in names})
        entries = walk(host, '/GA', depth=1, max_entries=10)
        note = entries[0]
        self.assertTrue(note['truncated'])
        self.assertEqual(note['total'], 500)
        self.assertEqual(note['listed'], 10)
        listed = [e['path'] for e in entries[1:]]
        self.assertEqual(len(listed), 10)
        self.assertEqual(listed[-1], '/GA/S59499')

    def test_a_directory_under_the_cap_carries_no_note(self):
        entries = walk(self.host, '/proof', depth=1, max_entries=10)
        self.assertFalse(any('truncated' in e for e in entries))

    def test_newest_first_and_directories_excluded(self):
        entries = walk(self.host, '/proof', depth=1)
        self.assertEqual(newest_files(entries, 1), ['/proof/new.jpg'])
        self.assertEqual(newest_files(walk(self.host, '/', depth=1), 5), [])


class Fetching(unittest.TestCase):
    def test_streams_the_whole_file_and_reports_its_size(self):
        host = FakeHost(blobs={'/proof/a.jpg': b'x' * 100})
        with tempfile.TemporaryDirectory() as tmp:
            dest = os.path.join(tmp, 'a.jpg')
            self.assertEqual(fetch(host, '/proof/a.jpg', dest), 100)
            with open(dest, 'rb') as f:
                self.assertEqual(f.read(), b'x' * 100)

    def test_a_file_over_the_cap_is_refused_mid_stream(self):
        # The cap is enforced on bytes received, so a server lying in stat()
        # about a 50GB tif still cannot fill the task's disk.
        host = FakeHost(blobs={'/GA/huge.tif': b'y' * 100})
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileTooLarge):
                fetch(host, '/GA/huge.tif', os.path.join(tmp, 'h.tif'), max_bytes=16)


class EnvParsing(unittest.TestCase):
    def test_missing_and_malformed_values_fall_back(self):
        for raw in ('', '  ', 'lots', '-3'):
            with self.subTest(raw=raw):
                os.environ['FTP_INSPECT_TEST'] = raw
                self.assertEqual(_env_int('FTP_INSPECT_TEST', 7), 7)
        os.environ.pop('FTP_INSPECT_TEST')

    def test_zero_is_honoured_rather_than_treated_as_unset(self):
        os.environ['FTP_INSPECT_TEST'] = '0'
        self.assertEqual(_env_int('FTP_INSPECT_TEST', 7), 0)
        os.environ.pop('FTP_INSPECT_TEST')


if __name__ == '__main__':
    unittest.main()
