"""Where a container gets its job.

S59976 -- a real order with 19 line items -- serialized to 16,004 bytes and blew
the 8192-byte ECS container-override cap during the 2026-09-13 live window. The
task could not start at all, so the order failed all four retries with no
container log to show for it. Ordinary orders are 1.5-3 KB, which is why this
survived every test until a big order arrived.

The job is now read from the META row the poller already wrote.
"""

import os
import sys
import unittest
from decimal import Decimal

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "services", "_common"))

from jobload import load_job, plain  # noqa: E402


class FakeTable:
    def __init__(self, item):
        self.item = item
        self.keys = []

    def get_item(self, Key):  # noqa: N803 - boto3's spelling
        self.keys.append(Key)
        return {"Item": self.item} if self.item is not None else {}


class FakeResource:
    def __init__(self, item):
        self.table = FakeTable(item)
        self.names = []

    def Table(self, name):  # noqa: N802 - boto3's spelling
        self.names.append(name)
        return self.table


META = {
    "PK": "ORDER#S59976",
    "SK": "META",
    "GSI1PK": "STATUS#in_queue",
    "GSI1SK": "2026-09-13T18:00:00.000Z",
    "orderName": "S59976",
    "status": "in_queue",
    "routing": {"facility": "NV", "transport": "FTP"},
    "renameDict": {"1-1": "569498398"},
    "items": [{"itemNo": Decimal("1"), "width": Decimal("3"),
               "height": Decimal("7.5"), "sku": "SKUVB"}],
}


class TheOverrideStillWins(unittest.TestCase):
    """Kept on purpose so the deploy order of workflow and image cannot matter."""

    def test_job_is_used_when_present_and_dynamodb_is_never_touched(self):
        res = FakeResource(META)
        job = load_job("S59976", env={"JOB": '{"orderName":"X","items":[]}'}, resource=res)
        self.assertEqual(job["orderName"], "X")
        self.assertEqual(res.names, [])


class ReadingTheMetaRow(unittest.TestCase):
    def setUp(self):
        self.res = FakeResource(META)
        self.job = load_job("S59976", env={"JOBS_TABLE": "sb-dev-jobs"}, resource=self.res)

    def test_it_reads_the_right_row(self):
        self.assertEqual(self.res.names, ["sb-dev-jobs"])
        self.assertEqual(self.res.table.keys,
                         [{"PK": "ORDER#S59976", "SK": "META"}])

    def test_the_fields_the_containers_actually_use_survive(self):
        self.assertEqual(self.job["routing"]["facility"], "NV")
        self.assertEqual(self.job["renameDict"], {"1-1": "569498398"})
        self.assertEqual(len(self.job["items"]), 1)

    def test_row_bookkeeping_is_not_passed_off_as_job_data(self):
        for key in ("PK", "SK", "GSI1PK", "GSI1SK"):
            self.assertNotIn(key, self.job)


class DecimalsBecomeNumbers(unittest.TestCase):
    """DynamoDB hands back Decimal; the pipeline does arithmetic and json.dumps.

    A Decimal width does not crash loudly -- it survives int() and float() -- so
    this would have shown up as wrong pixel sizes or a serialization error deep
    in a container rather than as an obvious failure.
    """

    def test_whole_numbers_become_int_not_float(self):
        item = load_job("S59976", env={"JOBS_TABLE": "t"},
                        resource=FakeResource(META))["items"][0]
        self.assertIsInstance(item["itemNo"], int)
        self.assertIsInstance(item["width"], int)
        self.assertEqual(item["width"], 3)

    def test_fractional_numbers_keep_their_value(self):
        item = load_job("S59976", env={"JOBS_TABLE": "t"},
                        resource=FakeResource(META))["items"][0]
        self.assertIsInstance(item["height"], float)
        self.assertEqual(item["height"], 7.5)

    def test_conversion_reaches_every_level_of_nesting(self):
        nested = plain({"a": [{"b": [Decimal("2")]}], "c": Decimal("0.5")})
        self.assertEqual(nested, {"a": [{"b": [2]}], "c": 0.5})
        self.assertIsInstance(nested["a"][0]["b"][0], int)

    def test_non_numbers_pass_through_untouched(self):
        self.assertEqual(plain({"s": "x", "b": True, "n": None}),
                         {"s": "x", "b": True, "n": None})


class WhenThereIsNothingToRead(unittest.TestCase):
    """Fail loudly. A container that silently proceeds on an empty job would
    produce a successful-looking run that printed nothing."""

    def test_a_missing_row_raises(self):
        with self.assertRaises(RuntimeError) as e:
            load_job("S59976", env={"JOBS_TABLE": "t"}, resource=FakeResource(None))
        self.assertIn("S59976", str(e.exception))

    def test_no_table_configured_raises(self):
        with self.assertRaises(RuntimeError):
            load_job("S59976", env={}, resource=FakeResource(META))

    def test_an_empty_job_override_falls_through_rather_than_parsing_as_empty(self):
        job = load_job("S59976", env={"JOB": "", "JOBS_TABLE": "t"},
                       resource=FakeResource(META))
        self.assertEqual(job["orderName"], "S59976")


if __name__ == "__main__":
    unittest.main()
