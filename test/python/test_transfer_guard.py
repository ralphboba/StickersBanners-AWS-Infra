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
import unittest.mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "services", "ftp"))

from guards import (transfers_enabled, is_demo_order, remote_path,  # noqa: E402
                    ftp_base_path, review_mode, transfer_destination,
                    TRANSPORTS, DIVERTIBLE)


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


REVIEW = {"FTP_BASE_PATH": "/AWS-TEST"}
REAL = {"FTP_BASE_PATH": ""}


class ReviewModeIsOneDecision(unittest.TestCase):
    """Setting a path prefix at all is the choice to divert for review."""

    def test_a_prefix_means_review(self):
        self.assertTrue(review_mode(REVIEW))

    def test_no_prefix_is_the_real_facility_layout(self):
        self.assertFalse(review_mode(REAL))
        self.assertFalse(review_mode({}))


class EveryFtpFacilityIsDiverted(unittest.TestCase):
    def test_the_prefix_reaches_all_four(self):
        for facility in ("GA", "NJ", "TX", "NV"):
            dest = transfer_destination(facility, "S1", REVIEW)
            self.assertEqual(dest["kind"], "ftp")
            self.assertTrue(dest["review"])
            self.assertEqual(dest["path"], f"/AWS-TEST/{facility}/S1")

    def test_without_review_they_go_to_the_real_facility_folder(self):
        dest = transfer_destination("GA", "S1", REAL)
        self.assertEqual(dest["path"], "/GA/S1")
        self.assertFalse(dest["review"])


class DriveCannotBeDiverted(unittest.TestCase):
    """The failure this whole resolver exists to prevent.

    Review mode used to be decided inside each transport, so Drive never asked
    the question: S59977 put six print files in the folder the CA facility
    collects from while every other facility that hour was correctly diverted.
    """

    def test_ca_is_held_in_review_mode_not_sent(self):
        dest = transfer_destination("CA", "S59977", REVIEW)
        self.assertEqual(dest["kind"], "hold")
        self.assertIn("drive", dest["reason"])

    def test_ca_uploads_normally_when_nothing_is_being_reviewed(self):
        self.assertEqual(transfer_destination("CA", "S59977", REAL)["kind"], "drive")
        self.assertEqual(transfer_destination("CA", "S59977", {})["kind"], "drive")


class ForgettingIsSafe(unittest.TestCase):
    """A transport added later must default to held, not to production.

    This is the structural half of the fix. The old code's default was to fall
    through to the real destination, so a transport nobody thought about reached
    production silently -- which is exactly what happened.
    """

    def test_an_undivertible_transport_is_held_rather_than_shipped(self):
        transports = dict(TRANSPORTS, ZZ="courier")   # a transport nobody taught review mode
        with unittest.mock.patch.dict("guards.TRANSPORTS", transports, clear=True):
            self.assertEqual(transfer_destination("ZZ", "S1", REVIEW)["kind"], "hold")

    def test_the_divertible_set_is_a_whitelist_not_a_blacklist(self):
        self.assertIn("ftp", DIVERTIBLE)
        self.assertNotIn("drive", DIVERTIBLE)
        self.assertNotIn("courier", DIVERTIBLE)


class AnUnknownFacilityIsRefused(unittest.TestCase):
    def test_it_raises_rather_than_guessing_a_destination(self):
        for facility in ("XX", "", None):
            with self.assertRaises(ValueError):
                transfer_destination(facility, "S1", REVIEW)
