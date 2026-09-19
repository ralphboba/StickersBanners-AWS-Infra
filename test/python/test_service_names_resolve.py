"""Every name a service module uses must actually be defined or imported.

This exists because of one line. The refactor that moved the review-path
decision above the transport layer rewrote the `from guards import ...` line in
src/services/ftp/main.py and dropped `remote_path`, which main.py still calls
directly when uploading invoice images. Python does not notice at import time --
only when the line runs -- so nothing failed until a real order with proof
images hit the Transfer step during the 2026-09-19 live window, and then every
one of them failed with `name 'remote_path' is not defined`.

Unit tests did not catch it: they exercise guards.py, where remote_path is
defined and used correctly. The DEMO path returns before reaching the call. The
container built and started fine. The only way to see it was to run a real
order, and by then the window was open.

So this checks the whole class rather than the one name: walk every service
module and assert that no Load-context name is unresolvable. It is a cheap
static check that would have failed in CI in under a second.
"""

import ast
import builtins
import os
import unittest

SERVICES = os.path.join(os.path.dirname(__file__), "..", "..", "src", "services")


def unresolved_names(path):
    """Names read by this module that it neither defines nor imports."""
    tree = ast.parse(open(path).read())
    defined = set(dir(builtins)) | {"__name__", "__file__", "__doc__"}

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defined.add(node.name)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            defined.add(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                defined.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.arg):
            defined.add(node.arg)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            defined.add(node.name)
        # Comprehension and lambda targets land in ast.Name/ast.arg above.

    missing = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            if node.id not in defined:
                missing.setdefault(node.id, []).append(node.lineno)
    return missing


def service_modules():
    for root, _dirs, files in os.walk(SERVICES):
        if "__pycache__" in root:
            continue
        for name in files:
            if name.endswith(".py"):
                yield os.path.join(root, name)


class TestNamesResolve(unittest.TestCase):
    def test_every_service_module_resolves_its_names(self):
        checked = 0
        for path in service_modules():
            checked += 1
            missing = unresolved_names(path)
            rel = os.path.relpath(path, os.path.join(SERVICES, "..", ".."))
            self.assertEqual(
                missing, {},
                f"{rel} uses names it never defines or imports: "
                + ", ".join(f"{n} (line {ls[0]})" for n, ls in sorted(missing.items())))
        self.assertGreater(checked, 5, "expected to find the service modules")

    def test_the_check_actually_catches_the_bug_it_was_written_for(self):
        # Guard against the checker quietly becoming a no-op.
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
            f.write("from guards import is_demo_order\n"
                    "def go():\n"
                    "    return remote_path('GA')\n")
            tmp = f.name
        try:
            self.assertIn("remote_path", unresolved_names(tmp))
        finally:
            os.unlink(tmp)


if __name__ == "__main__":
    unittest.main()
