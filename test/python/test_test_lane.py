"""Kai's test lane in the transfer service (2026-10-07).

A test-lane order (testLane on its job row, TEST_LANE enabled on the task) is
really transferred -- but only ever under /AWS-TEST on the FTP, or into the
"AWS-TEST" folder of the CA Drive. These pin that it can never resolve to a
path production picks up, and that the lane is off unless switched on.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "services", "ftp"))

from guards import (TEST_BASE_PATH, TEST_DRIVE_FOLDER, FACILITIES,  # noqa: E402
                    is_test_lane_job, test_lane_destination, test_lane_enabled)

ON = {"TEST_LANE": "enabled"}


class TheSwitch(unittest.TestCase):
    def test_off_unless_exactly_enabled(self):
        for v in ("", "disabled", "true", "1", "yes"):
            self.assertFalse(test_lane_enabled({"TEST_LANE": v}), v)
        self.assertFalse(test_lane_enabled({}))
        self.assertTrue(test_lane_enabled({"TEST_LANE": " Enabled "}))

    def test_a_job_needs_the_flag_and_the_switch(self):
        self.assertTrue(is_test_lane_job({"testLane": True}, ON))
        self.assertFalse(is_test_lane_job({"testLane": "true"}, ON))
        self.assertFalse(is_test_lane_job({}, ON))
        self.assertFalse(is_test_lane_job({"testLane": True}, {}))
        self.assertFalse(is_test_lane_job(None, ON))


class NeverARealPath(unittest.TestCase):
    def test_ftp_facilities_land_under_aws_test(self):
        for facility in ("GA", "NJ", "TX", "NV"):
            dest = test_lane_destination(facility, "S70001")
            self.assertEqual(dest["kind"], "ftp")
            self.assertEqual(dest["path"], f"{TEST_BASE_PATH}/{facility}/S70001")

    def test_ca_goes_to_the_drive_test_folder(self):
        dest = test_lane_destination("CA", "S70001")
        self.assertEqual(dest, {"kind": "drive", "subfolder": TEST_DRIVE_FOLDER, "test": True})

    def test_every_facility_is_covered(self):
        for facility in FACILITIES:
            dest = test_lane_destination(facility, "S1")
            self.assertTrue(dest.get("test"), facility)
            if dest["kind"] == "ftp":
                self.assertTrue(dest["path"].startswith(TEST_BASE_PATH + "/"), facility)
            else:
                self.assertEqual(dest.get("subfolder"), TEST_DRIVE_FOLDER)

    def test_unknown_facility_is_refused(self):
        for facility in ("XX", "", None):
            with self.assertRaises(ValueError):
                test_lane_destination(facility, "S1")


if __name__ == "__main__":
    unittest.main()
