"""The test kit as a product meets it: nothing of core's own tests in it, its copies still the originals,
and a consumer that runs fewer than all its store tests, or skips one, fails (A5)."""
import ast
import inspect
import os
from pathlib import Path
import subprocess
import sys
import textwrap
from types import SimpleNamespace

import pytest

import delphi_core_testkit
from delphi_core_testkit import conformance
from delphi_core_testkit.conformance import _support, memory_web_evidence
from tests import chat_keys, helpers, test_web_annotations
from tests.test_memory_gather import CAPTURE

KIT = Path(delphi_core_testkit.__file__).parent


def test_no_kit_module_imports_cores_own_tests():
    """Core's suite always has `tests` on its path, so only this sees a kit that a product cannot import."""
    for path in sorted(KIT.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            names = ([alias.name for alias in node.names] if isinstance(node, ast.Import)
                     else [node.module or ""] if isinstance(node, ast.ImportFrom) and node.level == 0 else [])
            assert not [name for name in names if name == "tests" or name.startswith("tests.")], \
                f"{path.relative_to(KIT)} imports {names}"


def code(obj) -> str:
    """An object's code without its docstrings: a copy names its original in its own."""
    tree = ast.parse(textwrap.dedent(inspect.getsource(obj)))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and ast.get_docstring(node) is not None:
            node.body = node.body[1:] or [ast.Pass()]
    return ast.dump(tree)


@pytest.mark.parametrize("copy, original", [
    (_support.chat_key, chat_keys.chat_key),
    (_support.html_payload, test_web_annotations.html_payload),
    (_support.ProviderTransport, helpers.ProviderTransport),
], ids=["chat_key", "html_payload", "ProviderTransport"])
def test_each_helper_the_kit_copies_is_still_its_original(copy, original):
    assert code(copy) == code(original)


def test_the_capture_the_kit_cites_is_the_one_cores_tests_store():
    assert memory_web_evidence.CAPTURE_ID == CAPTURE["id"]


def test_the_layering_checks_ship_in_the_kit_as_a_command():
    """A product's gate runs A1-A8 from its pinned kit: `python -m delphi_core_testkit.abstraction`."""
    assert {path.name for path in (KIT / "abstraction").glob("*.py")} >= {
        "__init__.py", "__main__.py", "a1_imports.py", "a3_surface.py", "a4_http.py", "a6_settings.py",
        "a7_same_code.py", "a8_private_names.py"}
    listed = subprocess.run([sys.executable, "-m", "delphi_core_testkit.abstraction"], capture_output=True, text=True, timeout=60)
    assert listed.returncode == 2 and "imports, surface, http, settings, versions, wheel, private-names" in listed.stderr


# --- A5: core's local consumer collects every kit store test, and skips none ----------

#: Core's consumer files, one per kit module, and the directory pytest runs them from.
CONSUMERS = [f"tests/test_{module}.py" for module in conformance.MODULES]
SUITE = Path(__file__).resolve().parents[1]


def collect(*args):
    """A collection of core's consumers as a gate makes it: with A5 required on the local store."""
    return subprocess.run([sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider", *args],
                          cwd=SUITE, env={**os.environ, conformance.REQUIRE_ENV: "local"},
                          capture_output=True, text=True, timeout=300)


def test_core_collects_every_kit_store_test_on_the_local_store():
    result = collect(*CONSUMERS)
    assert result.returncode == 0, result.stdout[-2000:] + result.stderr[-2000:]
    assert "conformance (" not in result.stdout


def test_a_kit_store_test_core_does_not_collect_fails_the_run():
    """Planted: a consumer file left out, and one test deselected. Each is named."""
    dropped = collect(*CONSUMERS[1:])
    assert dropped.returncode != 0
    assert f"not collected on 'local': test_{conformance.MODULES[0]}.py::" in dropped.stdout
    one = conformance.TESTS[-1]
    deselected = collect(*CONSUMERS, "-k", f"not {one.split('::')[1]}")
    assert deselected.returncode != 0
    assert f"not collected on 'local': {one}" in deselected.stdout


def kit_case(name, harness="local"):
    """A collected case as pytest hands it to the plugin, of a test in the module `w3a_kit.store`."""
    def function():
        pass
    function.__module__ = "w3a_kit.store"
    return SimpleNamespace(function=function, path=Path("test_store.py"), originalname=name,
                           nodeid=f"tests/test_store.py::{name}[{harness}]",
                           callspec=SimpleNamespace(params={"store_harness": SimpleNamespace(id=harness)}))


def finish(plugin, cases, skipped=()):
    session = SimpleNamespace(items=cases, exitstatus=pytest.ExitCode.OK,
                              config=SimpleNamespace(pluginmanager=SimpleNamespace(get_plugin=lambda name: None)))
    plugin.pytest_collection_finish(session)
    for case in cases:
        plugin.pytest_runtest_logreport(SimpleNamespace(nodeid=case.nodeid, skipped=case.originalname in skipped))
    plugin.pytest_sessionfinish(session, session.exitstatus)
    return session.exitstatus, plugin.problems


@pytest.mark.parametrize("cases, skipped, problems", [
    (["test_one", "test_two"], (), []),
    (["test_one", "test_two"], ("test_two",), ["skipped: test_store.py::test_two"]),
    (["test_one"], (), ["not collected on 'local': test_store.py::test_two"]),
], ids=["complete", "a-skip", "a-missing-test"])
def test_a5_fails_a_run_that_skipped_or_missed_a_kit_test(cases, skipped, problems):
    plugin = conformance.RequireConformance("local", expected=["test_store.py::test_one", "test_store.py::test_two"],
                                            prefix="w3a_kit.")
    status, found = finish(plugin, [kit_case(name) for name in cases], skipped)
    assert found == problems
    assert status == (pytest.ExitCode.TESTS_FAILED if problems else pytest.ExitCode.OK)


def test_a5_counts_a_kit_test_only_on_the_harness_it_names():
    plugin = conformance.RequireConformance("postgres", expected=["test_store.py::test_one"], prefix="w3a_kit.")
    status, found = finish(plugin, [kit_case("test_one", harness="local")])
    assert found == ["not collected on 'postgres': test_store.py::test_one"]
    assert status == pytest.ExitCode.TESTS_FAILED
