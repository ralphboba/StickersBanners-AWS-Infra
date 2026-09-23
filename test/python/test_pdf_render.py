"""PDF rasterisation bounds — run with `npm run test:python`.

S61866 on 2026-09-19: a 6x5 ft banner whose uploaded PDF had a 120x96 in page.
converter rendered every PDF at a flat 300 dpi, so that page came to 1.037
BILLION pixels and the 8 GB resize container was OOM-killed (exit 137) on all
four attempts. The order produced nothing.

Two things are pinned here, and they pull against each other on purpose:

  1. A page that fits the budget is STILL rendered at 300 dpi. Our print files
     are byte-identical to Linh's today (verified 2026-09-22 against /GA/S61803,
     /GA/S61828, /GA/S61831 on the facility FTP), and a dpi change would change
     those bytes. The step-down must only ever reach files that currently die.
  2. A page that does not fit steps down far enough to survive, but never below
     the density the output resize is about to ask for.

No PyMuPDF and no real file: pdf_render_dpi takes a rectangle, so a stub with
.width/.height in points is the whole fixture.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(
    os.path.dirname(__file__), '..', '..', 'src', 'services', 'resize'))


def _load_converter_constants():
    """Read the dpi logic out of converter.py without importing PIL/psd_tools.

    converter.py imports fitz, PIL and psd_tools at module scope; none of them
    are needed for the arithmetic under test and none are installed here.
    """
    path = os.path.join(os.path.dirname(__file__), '..', '..',
                        'src', 'services', 'resize', 'converter.py')
    with open(path, encoding='utf-8') as fh:
        source = fh.read()
    start = source.index('PDF_RENDER_DPI = 300')
    end = source.index('def pixmap_to_image')
    namespace = {}
    exec(compile(source[start:end], path, 'exec'), namespace)  # noqa: S102
    return namespace


NS = _load_converter_constants()
pdf_render_dpi = NS['pdf_render_dpi']
PDF_RENDER_DPI = NS['PDF_RENDER_DPI']
PDF_MAX_RENDER_PIXELS = NS['PDF_MAX_RENDER_PIXELS']


class Rect:
    """Just enough of fitz.Rect: a page box measured in points."""

    def __init__(self, width_in, height_in):
        self.width = width_in * 72.0
        self.height = height_in * 72.0


def pixels_at(width_in, height_in, dpi):
    return width_in * dpi * height_in * dpi


class PagesThatAlreadyWork(unittest.TestCase):
    """The byte-identical guarantee: these must not move."""

    def test_ordinary_page_sizes_keep_300_dpi(self):
        for width_in, height_in in [
            (8.5, 11),      # letter
            (24, 36),       # poster
            (36, 48),       # 3x4 ft banner
            (48, 96),       # 4x8 ft banner — 414 Mpx at 300 dpi, still fine
            (60, 120),      # 5x10 ft banner
        ]:
            with self.subTest(page=f'{width_in}x{height_in}in'):
                self.assertEqual(
                    pdf_render_dpi(Rect(width_in, height_in), 5184, 4320),
                    PDF_RENDER_DPI)

    def test_the_budget_sits_above_a_real_4x8ft_layout(self):
        # If this fails the budget was lowered into the range of files that
        # print correctly today, and their output bytes would change.
        self.assertGreater(PDF_MAX_RENDER_PIXELS, pixels_at(48, 96, PDF_RENDER_DPI))


class TheS61866Page(unittest.TestCase):
    """120x96 in, ordered as a 6x5 ft banner (5184x4320 px output)."""

    PAGE = (120.0, 96.0)
    OUT = (5184, 4320)

    def setUp(self):
        self.dpi = pdf_render_dpi(Rect(*self.PAGE), *self.OUT)

    def test_it_no_longer_renders_at_300(self):
        self.assertLess(self.dpi, PDF_RENDER_DPI)

    def test_it_now_fits_the_budget(self):
        self.assertLessEqual(pixels_at(*self.PAGE, self.dpi), PDF_MAX_RENDER_PIXELS)

    def test_it_still_out_resolves_the_output_it_feeds(self):
        # 5184 px across 120 in is 43.2 dpi. Rendering below that would lose
        # real detail; this is a memory cap, not a quality decision.
        needed = max(self.OUT[0] / self.PAGE[0], self.OUT[1] / self.PAGE[1])
        self.assertGreater(self.dpi, needed)

    def test_the_old_behaviour_is_what_broke(self):
        # The regression this file exists for: 1.037 billion pixels, ~3.1 GB as
        # RGB before PIL makes a single copy.
        self.assertGreater(pixels_at(*self.PAGE, PDF_RENDER_DPI), 1_000_000_000)


class TheFloorHolds(unittest.TestCase):
    """The step-down must never sample below the output's own density."""

    def test_an_enormous_page_for_an_enormous_output(self):
        # 600x600 in page, 50 ft output (43200 px). The budget alone would say
        # 44 dpi; the output needs 72. The floor wins.
        dpi = pdf_render_dpi(Rect(600, 600), 43200, 43200)
        self.assertGreaterEqual(dpi, 72)

    def test_the_floor_never_exceeds_the_ceiling(self):
        # Even when the output demands more than 300 dpi of the page, the
        # render stays at 300 — that is legacy's number and the resize can
        # upscale, exactly as it does today.
        self.assertEqual(pdf_render_dpi(Rect(10, 10), 43200, 43200), PDF_RENDER_DPI)


class DegenerateInput(unittest.TestCase):
    """A zero or negative page box must not divide by zero."""

    def test_zero_sized_page_falls_back_to_the_default(self):
        self.assertEqual(pdf_render_dpi(Rect(0, 10), 100, 100), PDF_RENDER_DPI)
        self.assertEqual(pdf_render_dpi(Rect(10, 0), 100, 100), PDF_RENDER_DPI)
        self.assertEqual(pdf_render_dpi(Rect(-5, 10), 100, 100), PDF_RENDER_DPI)


if __name__ == '__main__':
    unittest.main()
