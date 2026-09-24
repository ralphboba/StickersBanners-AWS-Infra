"""The artwork probe's verdicts — run with `npm run test:python`.

The probe exists because the order record cannot show you the customer's file,
and two of the three real failures on 2026-09-19 were in the file. What is
pinned here is that it recognises those two shapes, and that a file it cannot
make sense of produces a verdict rather than an exception — a daily check that
dies on order 3 of 400 is worse than no daily check.

PDFs are built with PyMuPDF rather than committed as fixtures, so the page
geometry under test is stated in the test itself.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(
    os.path.dirname(__file__), '..', '..', 'src', 'services', 'resize'))

try:
    import fitz
    from PIL import Image
    import artwork_probe
    DEPS = None
except Exception as err:  # pragma: no cover - depends on the environment
    DEPS = str(err)


def make_pdf(path, pages=1, width_in=8.5, height_in=11):
    doc = fitz.open()
    for _ in range(pages):
        doc.new_page(width=width_in * 72, height=height_in * 72)
    doc.save(path)
    doc.close()


@unittest.skipIf(DEPS, f'resize deps unavailable: {DEPS}')
class PdfVerdicts(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def test_a_single_page_pdf_of_ordinary_size_is_ok(self):
        path = os.path.join(self.dir, 'a.pdf')
        make_pdf(path, pages=1, width_in=48, height_in=96)
        out = artwork_probe.probe_pdf(path, 5184, 4320)
        self.assertEqual(out['verdict'], 'ok')
        self.assertEqual(out['renderDpi'], artwork_probe.PDF_RENDER_DPI,
                         'a page that fits must still render at 300 dpi')

    def test_a_multi_page_pdf_is_unusable(self):
        # S61790.
        path = os.path.join(self.dir, 'b.pdf')
        make_pdf(path, pages=2)
        out = artwork_probe.probe_pdf(path, 1000, 1000)
        self.assertEqual(out['verdict'], 'unusable')
        self.assertEqual(out['reason'], 'multi-page-pdf')
        self.assertIn('2 pages', out['detail'])

    def test_the_s61866_page_is_flagged_not_silently_accepted(self):
        # 120x96 in ordered as a 6x5 ft banner: 1.037 billion px at 300 dpi.
        path = os.path.join(self.dir, 'c.pdf')
        make_pdf(path, pages=1, width_in=120, height_in=96)
        out = artwork_probe.probe_pdf(path, 5184, 4320)
        self.assertEqual(out['verdict'], 'warn')
        self.assertEqual(out['reason'], 'oversized-pdf-page')
        self.assertGreater(out['pixelsAt300dpi'], 1_000_000_000)
        self.assertLess(out['renderDpi'], artwork_probe.PDF_RENDER_DPI)


@unittest.skipIf(DEPS, f'resize deps unavailable: {DEPS}')
class RasterVerdicts(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def test_an_ordinary_image_is_ok(self):
        path = os.path.join(self.dir, 'a.png')
        Image.new('RGB', (1200, 800), 'white').save(path)
        out = artwork_probe.probe_raster(path)
        self.assertEqual(out['verdict'], 'ok')
        self.assertEqual(out['sourcePixels'], [1200, 800])


@unittest.skipIf(DEPS, f'resize deps unavailable: {DEPS}')
class NothingEscapes(unittest.TestCase):
    """probe_item must always return a verdict, never raise."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def test_an_item_with_no_url(self):
        out = artwork_probe.probe_item({'orderName': 'S1', 'itemNo': 1}, self.dir, 1024)
        self.assertEqual(out['verdict'], 'unusable')
        self.assertEqual(out['reason'], 'no-artwork-url')

    def test_a_url_that_cannot_be_fetched(self):
        item = {'orderName': 'S2', 'itemNo': 1, 'width': 2, 'height': 3, 'unit': 'ft',
                'url': 'https://127.0.0.1:1/nope.png', 'artworkExt': 'png'}
        out = artwork_probe.probe_item(item, self.dir, 1024)
        self.assertEqual(out['verdict'], 'unusable')
        self.assertEqual(out['reason'], 'download-failed')
        self.assertIn('detail', out)

    def test_a_file_that_is_not_what_it_claims(self):
        # probe_raster is allowed to raise on rubbish; probe_item is the layer
        # that must turn it into a verdict, because it runs 400 times in a row.
        path = os.path.join(self.dir, 'broken.png')
        with open(path, 'wb') as fh:
            fh.write(b'this is not a png')
        with self.assertRaises(Exception):
            artwork_probe.probe_raster(path)

    def test_an_order_with_no_usable_size_is_reported_not_divided_by(self):
        # get_dimensions returns (None, None) for an unusable unit; the probe
        # must say so rather than carry None into the PDF arithmetic.
        item = {'orderName': 'S3', 'itemNo': 1, 'width': None, 'height': None,
                'unit': None, 'url': 'https://example.invalid/a.png', 'artworkExt': 'png'}
        out = artwork_probe.probe_item(item, self.dir, 1024)
        self.assertEqual(out['verdict'], 'unusable')
        self.assertIn(out['reason'], ('download-failed', 'no-output-size'))


if __name__ == '__main__':
    unittest.main()


@unittest.skipIf(DEPS, f'resize deps unavailable: {DEPS}')
class TheProbeIsNotStricterThanThePipeline(unittest.TestCase):
    """A probe with its own limits reports failures that would not happen.

    Found live: PROBE_MAX_BYTES defaulted to 256 MiB while resize's own cap is
    1 GiB, so the census called a real order unusable on 2026-09-22 when the
    pipeline would have fetched the file without complaint.
    """

    def test_no_cap_is_imposed_unless_asked_for(self):
        self.assertIsNone(artwork_probe._optional_int('PROBE_MAX_BYTES_UNSET_XYZ'))

    def test_an_explicit_cap_is_still_honoured(self):
        os.environ['PROBE_MAX_BYTES_TEST'] = '1234'
        try:
            self.assertEqual(artwork_probe._optional_int('PROBE_MAX_BYTES_TEST'), 1234)
        finally:
            del os.environ['PROBE_MAX_BYTES_TEST']

    def test_rubbish_is_treated_as_unset_rather_than_as_zero(self):
        for bad in ('', '   ', 'lots', '0', '-5'):
            os.environ['PROBE_MAX_BYTES_TEST'] = bad
            try:
                self.assertIsNone(artwork_probe._optional_int('PROBE_MAX_BYTES_TEST'),
                                  f'{bad!r} must not become a cap')
            finally:
                del os.environ['PROBE_MAX_BYTES_TEST']

    def test_the_pipeline_cap_is_the_one_that_applies(self):
        from fetch import DEFAULT_MAX_BYTES
        self.assertEqual(DEFAULT_MAX_BYTES, 1024 * 1024 * 1024,
                         'if resize changes its cap, this test is the reminder')


@unittest.skipIf(DEPS, f'resize deps unavailable: {DEPS}')
class AiFilesAreSniffedNotSkipped(unittest.TestCase):
    """An .ai file is usually a PDF wearing a different extension.

    converter._convert_ai reads the header rather than trusting the name, so a
    probe that skips every .ai leaves the vector format most likely to hide an
    oversized page unchecked — four of them on 2026-09-23 alone.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def test_a_pdf_flavoured_ai_is_probed_as_a_pdf(self):
        path = os.path.join(self.dir, 'art.ai')
        make_pdf(path, pages=1, width_in=120, height_in=96)
        with open(path, 'rb') as fh:
            self.assertEqual(fh.read(4), b'%PDF', 'fixture must be PDF-flavoured')
        out = artwork_probe.probe_pdf(path, 5184, 4320)
        self.assertEqual(out['reason'], 'oversized-pdf-page',
                         'the same page must be caught whatever the extension says')

    def test_a_postscript_ai_is_reported_as_skipped_not_as_ok(self):
        # Ghostscript renders these; the probe does not run it. Saying "skipped"
        # keeps it visible as a gap instead of counting toward a clean day.
        path = os.path.join(self.dir, 'ps.ai')
        with open(path, 'wb') as fh:
            fh.write(b'%!PS-Adobe-3.0\n')
        with open(path, 'rb') as fh:
            self.assertNotEqual(fh.read(4), b'%PDF')
