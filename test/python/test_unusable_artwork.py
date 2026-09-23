"""Unusable artwork lands in front of a person — `npm run test:python`.

S61790 on 2026-09-19: the customer uploaded a two-page PDF. Legacy rejects those
too (imageWorker.py:156) and so do we, correctly — but the rejection came out as
a bare RuntimeError, which made it a failed Step Functions execution and nothing
else. Nobody is assigned to read failed executions, so an order that only needed
"please resend one page" sat there.

The fix is a separate exception type and a hold written the way the intake gate
writes one, so the order shows up in the manual folder with a reason. What is
pinned here is the classification and the shape of that hold; main.py is parsed
rather than imported, because importing it needs boto3, PyMuPDF, Pillow and live
environment variables.
"""

import ast
import os
import unittest

MAIN = os.path.join(os.path.dirname(__file__), '..', '..',
                    'src', 'services', 'resize', 'main.py')

with open(MAIN, encoding='utf-8') as fh:
    SOURCE = fh.read()
TREE = ast.parse(SOURCE)


def find(node_type, name):
    for node in ast.walk(TREE):
        if isinstance(node, node_type) and node.name == name:
            return node
    return None


class TheExceptionExists(unittest.TestCase):

    def test_unusable_artwork_is_its_own_type(self):
        cls = find(ast.ClassDef, 'UnusableArtwork')
        self.assertIsNotNone(cls, 'UnusableArtwork must be declared in main.py')
        bases = [b.id for b in cls.bases if isinstance(b, ast.Name)]
        self.assertIn('RuntimeError', bases)

    def test_it_is_not_confused_with_an_ordinary_failure(self):
        # Within the SAME try — ordering only means anything there. Other
        # functions have their own `except Exception` and are irrelevant here.
        for node in ast.walk(TREE):
            if not isinstance(node, ast.Try):
                continue
            names = [h.type.id for h in node.handlers if isinstance(h.type, ast.Name)]
            if 'UnusableArtwork' not in names:
                continue
            self.assertIn('Exception', names,
                          'the entrypoint must still catch everything else')
            self.assertLess(names.index('UnusableArtwork'), names.index('Exception'),
                            'UnusableArtwork must be caught before the catch-all')
            return
        self.fail('no try block catches UnusableArtwork')


class TheMultiPagePdfRaisesIt(unittest.TestCase):

    def test_the_page_count_check_raises_unusable_artwork(self):
        fn = find(ast.FunctionDef, 'fetch_artwork')
        self.assertIsNotNone(fn)
        raised = [
            node.exc.func.id
            for node in ast.walk(fn)
            if isinstance(node, ast.Raise)
            and isinstance(node.exc, ast.Call)
            and isinstance(node.exc.func, ast.Name)
        ]
        self.assertIn('UnusableArtwork', raised)

    def test_the_single_page_rule_is_still_the_legacy_one(self):
        # Legacy prints page 1 and only page 1; this must stay a rejection of
        # anything that is not exactly one page, not a "take the first page".
        self.assertIn('pages != 1', SOURCE)
        self.assertIn('check_pdf_pages', SOURCE)


class TheHoldIsShapedLikeTheGates(unittest.TestCase):

    def setUp(self):
        self.fn = find(ast.FunctionDef, 'hold_for_review')
        self.assertIsNotNone(self.fn, 'hold_for_review must exist')
        self.body = ast.get_source_segment(SOURCE, self.fn)

    def test_it_writes_the_same_status_the_intake_gate_writes(self):
        self.assertIn('STATUS#needs_review', self.body)
        self.assertIn('needs_review', self.body)

    def test_it_records_a_reason_a_person_can_act_on(self):
        self.assertIn('reason', self.body)
        self.assertIn('explain', self.body)
        self.assertIn('bad-artwork', SOURCE)

    def test_it_never_raises(self):
        # A cosmetic write must not replace the real error on the way out.
        self.assertTrue(
            any(isinstance(n, ast.Try) for n in ast.walk(self.fn)),
            'hold_for_review must swallow its own failures')

    def test_it_is_called_for_unusable_artwork(self):
        for node in ast.walk(TREE):
            if isinstance(node, ast.ExceptHandler) and isinstance(node.type, ast.Name) \
                    and node.type.id == 'UnusableArtwork':
                called = [
                    n.func.id for n in ast.walk(node)
                    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                ]
                self.assertIn('hold_for_review', called)
                return
        self.fail('no UnusableArtwork handler found')

    def test_the_task_still_exits_non_zero(self):
        # The order is held, but the pipeline must not carry on to finish and
        # transfer with nothing to send.
        self.assertIn('sys.exit(1)', SOURCE)


if __name__ == '__main__':
    unittest.main()
