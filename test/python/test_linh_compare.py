"""Linh-vs-ours comparison tests — run with `npm run test:python`.

The comparison decides what lands in Kai's inbox, so its verdicts are pinned
here against fake folders built from what the 2026-10-12 dry run actually saw
on the facility FTP (the "  qty 2" double space, CO files we did not make, PDF
sources whose pixels differ, Linh's TIFFs keeping their IFD at the end).
"""

import os
import struct
import sys
import unittest

sys.path.insert(0, os.path.join(
    os.path.dirname(__file__), '..', '..', 'src', 'services', 'ftp'))

from linh_compare import (  # noqa: E402
    compare_order, folder_signature, format_alert, format_summary, is_invoice,
    needs_alert, norm_name, tiff_info,
)

NOW = 1_800_000_000
OLD = NOW - 5 * 3600


def tiff(w, h, ifd_at_end=True, pixels=64):
    """A minimal little-endian TIFF, IFD after the pixels like Linh's."""
    entries = [(256, 4, 1, w), (257, 4, 1, h), (259, 3, 1, 5)]
    ifd = struct.pack('<H', len(entries))
    for tag, typ, n, val in entries:
        if typ == 3:
            ifd += struct.pack('<HHIHH', tag, typ, n, val, 0)
        else:
            ifd += struct.pack('<HHII', tag, typ, n, val)
    ifd += struct.pack('<I', 0)
    body = b'\0' * pixels
    if ifd_at_end:
        return b'II*\0' + struct.pack('<I', 8 + len(body)) + body + ifd
    return b'II*\0' + struct.pack('<I', 8) + ifd + body


def reader(data):
    return lambda off, n: data[off:off + n]


def meta(**kw):
    m = {'status': 'proofing', 'routing': {'facility': 'TX'}, 'renameDict': {'1-1': '575779784'},
         'items': [{'artworkExt': 'png'}]}
    m.update(kw)
    return m


def sampler(hashes=None, headers=None):
    hashes = hashes or {}
    headers = headers or {}

    def sample(side, name, size, kind):
        if kind == 'hash':
            return hashes.get((side, name), 'same')
        return headers.get((side, name))
    return sample


def kinds(res):
    return [p['k'] for p in res['problems']]


class Helpers(unittest.TestCase):
    def test_names_equal_apart_from_spacing(self):
        self.assertEqual(norm_name('S67985-1-1  qty 2.tif'), norm_name('S67985-1-1 qty 2.tif'))
        self.assertNotEqual(norm_name('S1-1-1 CO.tif'), norm_name('S1-1-1 .tif'))

    def test_invoice_names(self):
        self.assertTrue(is_invoice('575779784.jpg'))
        self.assertTrue(is_invoice('1-1.jpg'))
        self.assertFalse(is_invoice('S1-1-1 .tif'))

    def test_tiff_size_read_where_the_ifd_is(self):
        for at_end in (True, False):
            data = tiff(2592, 6048, ifd_at_end=at_end)
            self.assertEqual(tiff_info(reader(data), len(data)), {'w': 2592, 'h': 6048})

    def test_not_a_tiff(self):
        data = b'%PDF-1.7 ' + b'x' * 50
        self.assertIsNone(tiff_info(reader(data), len(data)))

    def test_signature_follows_the_folder(self):
        a = [{'name': 'a.tif', 'size': 1}, {'name': '1.jpg', 'size': 2}]
        self.assertEqual(folder_signature(a), folder_signature(list(reversed(a))))
        self.assertNotEqual(folder_signature(a), folder_signature([{'name': 'a.tif', 'size': 3}]))


class Verdicts(unittest.TestCase):
    linh = [{'name': 'S1-1-1 .tif', 'size': 100}, {'name': '575779784.jpg', 'size': 7}]
    ours = [{'name': 'S1-1-1 .tif', 'size': 100}, {'name': '1-1.jpg', 'size': 7}]

    def run_one(self, linh=None, m='default', ours=None, sample=None, mtime=OLD, fac='TX'):
        return compare_order('S1', fac, self.linh if linh is None else linh,
                             meta() if m == 'default' else m,
                             self.ours if ours is None else ours,
                             sample or sampler(), NOW, mtime)

    def test_identical_order_matches(self):
        res = self.run_one()
        self.assertEqual(res['verdict'], 'match')
        self.assertEqual(res['problems'], [])

    def test_qty_double_space_is_a_name_difference(self):
        res = self.run_one(linh=[{'name': 'S1-1-1  qty 2.tif', 'size': 100}],
                           ours=[{'name': 'S1-1-1 qty 2.tif', 'size': 100}])
        self.assertEqual(res['verdict'], 'diff')
        self.assertEqual(kinds(res), ['name'])

    def test_finishing_suffix_we_did_not_make(self):
        res = self.run_one(linh=[{'name': 'S1-1-1 CO.tif', 'size': 100}],
                           ours=[{'name': 'S1-1-1 .tif', 'size': 90}])
        self.assertEqual(kinds(res), ['file', 'file'])
        self.assertIn('CO', res['problems'][0]['t'])

    def test_facility_differs(self):
        res = self.run_one(fac='GA')
        self.assertEqual(kinds(res), ['facility'])

    def test_same_size_different_bytes(self):
        res = self.run_one(sample=sampler(hashes={('linh', 'S1-1-1 .tif'): 'x'}))
        self.assertEqual(kinds(res), ['content'])

    def test_sizes_differ_reports_pixels_and_skips_thumbnails(self):
        headers = {('linh', 'S1-1-1 .tif'): {'w': 2592, 'h': 6048},
                   ('ours', 'S1-1-1 .tif'): {'w': 6048, 'h': 2592}}
        res = self.run_one(ours=[{'name': 'S1-1-1 .tif', 'size': 120}, {'name': '1-1.jpg', 'size': 9}],
                           sample=sampler(headers=headers))
        self.assertEqual(kinds(res), ['content'])  # the jpg differs too, but that is not news
        self.assertIn('가로세로가 뒤집힘', res['problems'][0]['t'])

    def test_invoice_renamed_like_the_transfer(self):
        res = self.run_one(ours=[{'name': 'S1-1-1 .tif', 'size': 100}, {'name': '1-1.jpg', 'size': 8}])
        self.assertEqual(kinds(res), ['invoice'])

    def test_order_we_never_took_in(self):
        self.assertEqual(self.run_one(m=None)['verdict'], 'missing')
        self.assertEqual(self.run_one(m={'mirror': True})['verdict'], 'missing')

    def test_failed_and_held(self):
        self.assertEqual(self.run_one(m=meta(status='failed'))['verdict'], 'failed')
        held = self.run_one(m=meta(status='needs_review', hold={'reason': 'special-instructions'}))
        self.assertEqual(held['verdict'], 'held')
        self.assertEqual(held['problems'], [])

    def test_no_files_yet_is_pending_then_late(self):
        self.assertEqual(self.run_one(ours=[], mtime=NOW - 600)['verdict'], 'pending')
        late = self.run_one(ours=[], mtime=OLD)
        self.assertEqual(kinds(late), ['late'])

    def test_office_made_files_are_marked(self):
        self.assertEqual(self.run_one(m=meta(manualFiles=True))['verdict'], 'manual')

    def test_source_type_is_kept_for_the_email(self):
        res = self.run_one(m=meta(items=[{'artworkExt': 'PDF'}, {'artworkExt': 'png'}]))
        self.assertEqual(res['source'], 'pdf,png')


class Alerts(unittest.TestCase):
    def res(self, verdict='diff', problems=None, order='S1', source='pdf'):
        return {'order': order, 'facility': 'GA', 'verdict': verdict, 'source': source,
                'problems': problems if problems is not None else [{'k': 'content', 't': '"S1-1-1 .tif" (...)'}]}

    def test_a_finding_is_sent_once(self):
        r = self.res()
        self.assertTrue(needs_alert(None, r))
        sent = {'verdict': 'diff', 'problems': r['problems'], 'alerted': True}
        self.assertFalse(needs_alert(sent, r))
        unsent = dict(sent, alerted=False)
        self.assertTrue(needs_alert(unsent, r))
        changed = self.res(problems=[{'k': 'name', 't': 'x'}])
        self.assertTrue(needs_alert(sent, changed))

    def test_matches_and_holds_never_alert(self):
        self.assertFalse(needs_alert(None, self.res('match', [])))
        self.assertFalse(needs_alert(None, self.res('held', [])))

    def test_email_groups_by_kind_and_counts_pdf(self):
        rs = [self.res(order='S1'), self.res(order='S2', source='png'),
              self.res(order='S3', verdict='failed', problems=[{'k': 'failed', 't': '우리 처리 실패'}])]
        subject, body = format_alert(rs)
        self.assertLessEqual(len(subject), 99)
        self.assertIn('3건', subject)
        self.assertLess(body.index('우리 처리 실패'), body.index('파일 내용이 다름'))
        self.assertIn('원본이 PDF인 주문: 1건', body)

    def test_daily_summary(self):
        entries = [dict(self.res(order='S1'), problems=[{'k': 'name', 't': 'x'}]),
                   self.res(order='S2', verdict='match', problems=[]),
                   self.res(order='S3', verdict='held', problems=[])]
        subject, body = format_summary(entries, '10/12')
        self.assertIn('3건 중 같음 1, 다름 1', subject)
        self.assertIn('파일 이름만 다름 1건: S1', body)


if __name__ == '__main__':
    unittest.main()
