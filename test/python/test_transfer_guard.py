"""The production-transfer kill switch.

src/services/ftp/main.py is the only code that puts print files in front of
the production team. Linh's program is processing the same orders today, so an
unheld transfer means two copies of every file in the facility's folder -- and
the second one is only "extra" until somebody prints it.

These pin that the switch stays off unless deliberately armed. Run with
`npm run test:python`.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "services", "ftp"))

from guards import (transfers_enabled, is_demo_order, remote_path,  # noqa: E402
                    ftp_base_path, drive_would_escape_review)


class TransferSwitch(unittest.TestCase):
    def test_absent_means_off(self):
        self.assertFalse(transfers_enabled({}))

    def test_only_the_exact_word_arms_it(self):
        # A stray truthy value must not arm the one irreversible step.
        for value in ["", "disabled", "no", "false", "0", "1", "true", "yes", "enable", "ENABLED_"]:
            self.assertFalse(transfers_enabled({"PRODUCTION_TRANSFER": value}),
                             f"{value!r} must not arm transfers")

    def test_enabled_arms_it_regardless_of_case_or_padding(self):
        for value in ["enabled", "ENABLED", "  Enabled  "]:
            self.assertTrue(transfers_enabled({"PRODUCTION_TRANSFER": value}),
                            f"{value!r} must arm transfers")

    def test_it_reads_the_process_environment_when_not_injected(self):
        before = os.environ.get("PRODUCTION_TRANSFER")
        try:
            os.environ["PRODUCTION_TRANSFER"] = "enabled"
            self.assertTrue(transfers_enabled())
            os.environ["PRODUCTION_TRANSFER"] = "disabled"
            self.assertFalse(transfers_enabled())
        finally:
            if before is None:
                os.environ.pop("PRODUCTION_TRANSFER", None)
            else:
                os.environ["PRODUCTION_TRANSFER"] = before


class SyntheticOrderGuard(unittest.TestCase):
    """Independent of the switch: synthetic orders never transfer, ever."""

    def test_demo_and_zz_orders_are_caught(self):
        for name in ["DEMO-1", "demo-9", "ZZ-TEST", "zz-1"]:
            self.assertTrue(is_demo_order(name), name)

    def test_real_order_names_are_not(self):
        # Both live shapes: Shopify (S#####) and QTS (numeric).
        for name in ["S59121", "203492060", "SB-1", ""]:
            self.assertFalse(is_demo_order(name), name)

    def test_non_strings_do_not_crash_the_guard(self):
        for name in [None, 123, [], {}]:
            self.assertFalse(is_demo_order(name), repr(name))


if __name__ == "__main__":
    unittest.main()


class TrialPathPrefix(unittest.TestCase):
    """Where a print file lands is the other half of 'does production see it'."""

    def test_unset_means_the_real_facility_layout(self):
        self.assertEqual(remote_path("GA", "S59911", env={}), "/GA/S59911")
        self.assertEqual(remote_path("/Proof", "569315285.jpg", env={}),
                         "/Proof/569315285.jpg")

    def test_a_prefix_diverts_both_the_order_folder_and_the_proof(self):
        env = {"FTP_BASE_PATH": "/AWS-TEST"}
        self.assertEqual(remote_path("GA", "S59911", env=env), "/AWS-TEST/GA/S59911")
        self.assertEqual(remote_path("/Proof", "569315285.jpg", env=env),
                         "/AWS-TEST/Proof/569315285.jpg")

    def test_slashes_are_forgiving(self):
        for raw in ("/AWS-TEST", "AWS-TEST", "/AWS-TEST/", "  /AWS-TEST/  "):
            with self.subTest(raw=raw):
                self.assertEqual(remote_path("GA", "S1", env={"FTP_BASE_PATH": raw}),
                                 "/AWS-TEST/GA/S1")

    def test_an_empty_or_slash_only_value_is_the_real_layout(self):
        # Otherwise a blanked-out variable would write to "//GA/S1" and the
        # facility would quietly stop seeing files.
        for raw in ("", "   ", "/", "///"):
            with self.subTest(raw=raw):
                self.assertEqual(remote_path("GA", "S1", env={"FTP_BASE_PATH": raw}), "/GA/S1")

    def test_empty_segments_do_not_produce_double_slashes(self):
        self.assertEqual(remote_path("GA", "", "S1", env={}), "/GA/S1")


class CaDriveRespectsReviewPath(unittest.TestCase):
    """The review path is FTP-only, so CA has to be held rather than diverted.

    FTP_BASE_PATH prefixes every remote FTP path, but CA uploads into the real
    production Drive parent and there is no prefix to apply. During the
    2026-09-13 window S59977's six print files went straight into the folder the
    CA facility collects from, while every other facility was safely diverted.

    WHAT THIS DOES NOT COVER: the full path. In main.py the DEMO check and the
    PRODUCTION_TRANSFER check both return before this one, so reaching it for
    real means arming live transfers. These test the decision, not the transfer.
    """

    REVIEW = {"FTP_BASE_PATH": "/AWS-TEST"}
    REAL = {"FTP_BASE_PATH": ""}

    def test_ca_is_held_while_the_review_path_is_on(self):
        self.assertTrue(drive_would_escape_review("CA", self.REVIEW))

    def test_every_ftp_facility_is_divertible_and_so_is_not_held(self):
        for facility in ("GA", "NJ", "TX", "NV"):
            self.assertFalse(drive_would_escape_review(facility, self.REVIEW),
                             f"{facility} goes over FTP and the prefix diverts it")

    def test_ca_uploads_normally_when_there_is_no_review_path(self):
        # No prefix means the real facility layout -- the ordinary arrangement
        # where CA is supposed to reach the Drive.
        self.assertFalse(drive_would_escape_review("CA", self.REAL))
        self.assertFalse(drive_would_escape_review("CA", {}))

    def test_a_prefix_means_the_reviewer_chose_to_hold_everything(self):
        self.assertTrue(ftp_base_path(self.REVIEW))

    def test_no_prefix_is_the_real_layout_where_ca_may_upload(self):
        self.assertEqual(ftp_base_path(self.REAL), "")
        self.assertEqual(ftp_base_path({}), "")
