"""The extension an artwork file is saved under.

Order 203492170 failed all four retries during the 2026-09-13 live window with
"Unsupported file extension: aspx". It was a legacy QTS order, not a Shopify
one, and those carry a redirect endpoint as the artwork URL: the path ends in
.aspx and the real filename is buried in the query string. Intake had already
resolved this correctly into artworkExt; resize threw the answer away and
re-derived a wrong one from the URL path.

Shopify orders hid it completely — their URLs end in the real extension, so
path and artworkExt agree and either works.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "services", "resize"))

from artwork import artwork_extension  # noqa: E402

LEGACY_URL = (
    "http://64.57.252.249:8080/file_redirect.aspx"
    "?file=cec7c25d-a949-483c-9925-993e985c48d9___FILE_name_IS___IMG9281.png"
)


class LegacyQtsUrls(unittest.TestCase):
    def test_the_resolved_extension_wins_over_the_aspx_path(self):
        self.assertEqual(artwork_extension({"artworkExt": "png"}, LEGACY_URL), "png")

    def test_without_it_the_path_still_yields_the_old_wrong_answer(self):
        # Not a desired behaviour -- a record of why the fallback alone is not
        # enough, so nobody "simplifies" back to deriving from the URL.
        self.assertEqual(artwork_extension({}, LEGACY_URL), "aspx")


class ShopifyUrls(unittest.TestCase):
    URL = "https://sticker-banner-large-file-uploads.s3.eu-north-1.amazonaws.com/2026-09-13/1/IMG_6817.png"

    def test_both_sources_agree(self):
        self.assertEqual(artwork_extension({"artworkExt": "png"}, self.URL), "png")
        self.assertEqual(artwork_extension({}, self.URL), "png")

    def test_a_query_string_does_not_confuse_the_fallback(self):
        self.assertEqual(artwork_extension({}, self.URL + "?v=2"), "png")


class Normalisation(unittest.TestCase):
    def test_case_dot_and_whitespace_are_stripped(self):
        for raw in ("PNG", ".png", " png ", ".PNG"):
            self.assertEqual(artwork_extension({"artworkExt": raw}, ""), "png")

    def test_empty_values_fall_through_rather_than_becoming_the_extension(self):
        for raw in ("", "   ", None):
            self.assertEqual(artwork_extension({"artworkExt": raw}, "x/y.tif"), "tif")

    def test_pdf_is_the_last_resort_when_there_is_nothing_to_go_on(self):
        self.assertEqual(artwork_extension({}, ""), "pdf")
        self.assertEqual(artwork_extension(None, ""), "pdf")


if __name__ == "__main__":
    unittest.main()
