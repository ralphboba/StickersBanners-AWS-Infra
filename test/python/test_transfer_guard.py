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

from guards import transfers_enabled, is_demo_order  # noqa: E402


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
