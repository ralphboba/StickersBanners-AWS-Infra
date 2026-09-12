"""Parity with Linh's real output — run with `npm run test:python`.

Every expectation here was read off files his program actually produced, pulled
from the facility FTP on 2026-09-12 (see src/services/ftp/ftp_inspect.py for how).
Until then the port had been checked only against his source, never against a
file production had received, and both of these were wrong in ways no amount of
re-reading the source would have shown.

Orders used:
  S59902 item 1   SKUMB 48x24 in, Hem & Grommets      -> "S59902-1-1 .tif"
  S59902 item 13  SKUMB 72x46 in, Hem & Grommets      -> "S59902-13-1 .tif"
  S59911 item 1   92x92 in, Pole Pockets Top+Bottom   -> "S59911-1-1 PPTB.tif"
  S59906 item 1   SKUCSR 46x72 in, Pole Pockets Top   -> "S59906-1-1 PPTO.tif"
  S59900 item 1   Grommets Only                       -> "S59900-1-1 GO.tif"
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(
    os.path.dirname(__file__), '..', '..', 'src', 'services', 'finish'))

from finishing_config import final_tif_name  # noqa: E402


class PrintFileNames(unittest.TestCase):
    """Names copied character-for-character from the facility FTP listing."""

    def test_a_pole_pocket_order_keeps_its_suffix(self):
        self.assertEqual(
            final_tif_name('S59911', '1-1', {'specialFinishing': 'PPTB', 'descSuf': 'PPTB'}),
            'S59911-1-1 PPTB.tif')

    def test_top_only_and_grommets_only_suffixes(self):
        self.assertEqual(
            final_tif_name('S59906', '1-1', {'specialFinishing': 'PPTO', 'descSuf': 'PPTO'}),
            'S59906-1-1 PPTO.tif')
        self.assertEqual(
            final_tif_name('S59900', '1-1', {'descSuf': 'GO'}),
            'S59900-1-1 GO.tif')

    def test_hem_and_grommets_leaves_a_trailing_space(self):
        # Hem & Grommets carries no descSuf, and legacy does NOT trim the
        # separator — the file on the FTP really is "S59902-1-1 .tif".
        self.assertEqual(
            final_tif_name('S59902', '1-1', {'grommets': {'sides': ['top']}}),
            'S59902-1-1 .tif')
        self.assertEqual(
            final_tif_name('S59902', '13-1', {'grommets': {'sides': ['top']}}),
            'S59902-13-1 .tif')

    def test_the_space_survives_an_empty_descsuf_too(self):
        self.assertEqual(final_tif_name('S1', '1-1', {}), 'S1-1-1 .tif')
        self.assertEqual(final_tif_name('S1', '1-1', {'descSuf': ''}), 'S1-1-1 .tif')

    def test_a_quantity_over_one_is_appended(self):
        self.assertEqual(
            final_tif_name('S1', '1-1', {'descSuf': 'GO', 'quantity': 3}),
            'S1-1-1 GO qty 3.tif')

    def test_quantity_one_adds_nothing(self):
        self.assertEqual(
            final_tif_name('S1', '1-1', {'descSuf': 'GO', 'quantity': 1}),
            'S1-1-1 GO.tif')


class ProofFolderCasing(unittest.TestCase):
    """Checked against the source text, not by import.

    ftp/main.py needs ftputil and boto3 at import time, and its module name
    collides with finish/main.py. The constant is a literal, so reading it out
    of the file is both sufficient and less fragile than importing.
    """

    SOURCE = os.path.join(os.path.dirname(__file__), '..', '..',
                          'src', 'services', 'ftp', 'main.py')

    def setUp(self):
        with open(self.SOURCE) as f:
            self.text = f.read()

    def test_the_invoice_proof_folder_is_capital_p(self):
        # /Proof is the folder Linh's program fills — 382,374 files when it was
        # listed on 2026-09-12. A lowercase /proof is a second folder nobody
        # watches on a case-sensitive server, and the proof silently never
        # reaches production.
        self.assertIn('PROOF_DIR = "/Proof"', self.text)

    def test_no_lowercase_proof_path_is_left_anywhere(self):
        self.assertNotIn('"/proof"', self.text)
        self.assertNotIn("'/proof'", self.text)

    def test_the_upload_uses_the_constant_rather_than_a_literal(self):
        self.assertIn('ftp_host.path.join(PROOF_DIR,', self.text)


if __name__ == '__main__':
    unittest.main()
