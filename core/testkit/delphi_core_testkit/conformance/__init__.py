"""The store tests: one contract, asserted against every `Storage` a product brings.

A consumer runs them over its own stores, with three things of its own:

- a `store_harness` fixture, parametrized over its `StoreHarness`es, each
  with the harness's `id` as its pytest id;
- `pytest.register_assert_rewrite("delphi_core_testkit")` in its conftest,
  before anything imports the kit, or a failing assert loses its detail;
- one test module per module here, named `test_<module>.py`, importing that
  module's tests and fixtures by explicit name.

A test's id is then `test_<module>.py::<test>[<harness id>…]`. `TESTS` lists
every one, by that file and name, so a consumer can show it collected each
of them and skipped none: its `pytest_configure` calls `require_conformance`,
which fails the run when `DELPHI_REQUIRE_CONFORMANCE` names a harness and either
does not hold (A5).

Importing this package imports core's reference app, which reads the process
environment and `../.env` once: empty what the suite must not inherit in the
conftest first, as core's empties the provider key, or a developer's
configuration reaches the suite.

Each module's `storage` (or `store`) fixture opens a store through the
harness and creates the account `reader`. A test that needs something only a
store's implementation can give, an account lock held from outside or a job
kind held back, asks the harness for it.
"""
from __future__ import annotations

from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any, Callable, Protocol

import pytest

from delphi_core.storage import Storage


class StoreHarness(Protocol):
    """How a consumer opens its store, and reaches the two things only its implementation holds."""

    #: The pytest id of the harness's cases: `local`, `postgres`.
    id: str

    def make(self, tmp_path: Path) -> Storage:
        """A store with nothing in it, its data under `tmp_path` if it keeps any on disk."""

    def hold_account_lock(
        self, storage: Storage, username: str
    ) -> AbstractContextManager[Callable[[], dict[str, Any] | None]]:
        """
        Hold, from this thread, the account lock that a fenced commit
        (`commit_memory_update`) and onboarding's cleanup (`settle_onboarding`)
        both take, and yield `cleanup`.

        `cleanup()` makes onboarding's cleanup of the account's queued jobs
        under the held lock. Where the lock is re-entrant, it is
        `settle_onboarding(username, require_filing=True)` itself, and returns
        its answer. Where the lock is a row another session holds, it deletes
        the account's job rows in that session and returns None; the test
        then asks `settle_onboarding` once the lock is released.
        """

    def hold_job_kinds(self, monkeypatch: pytest.MonkeyPatch, kinds: tuple[str, ...]) -> None:
        """
        Make the store's claim hold back jobs of `kinds`, as `HELD_JOB_KINDS`
        names them. The test sets core's own rule (`storage.base`); this is
        for a store that bound the tuple itself when it was imported.
        """


#: The modules, in the order a consumer's files run them.
MODULES = (
    "storage_contract",
    "memory_commit",
    "memory_lint",
    "memory_routes",
    "memory_sessions",
    "memory_web_evidence",
    "multiple_conversations",
    "plans",
    "prompts",
)


def _tests() -> tuple[str, ...]:
    from importlib import import_module

    found = []
    for name in MODULES:
        module = import_module(f"{__name__}.{name}")
        found += [
            f"test_{name}.py::{test}" for test, value in vars(module).items()
            if test.startswith("test_") and callable(value) and getattr(value, "__module__", None) == module.__name__
        ]
    return tuple(found)


#: Every test here, as `test_<module>.py::<test>`: the consumer's file and the test's name.
TESTS = _tests()


# --- A5: a consumer ran every test here on its store, and skipped none --------------

#: Name a harness id here (`local`, `postgres`) and `require_conformance` fails the
#: run unless it collected every test in `TESTS` on that harness and skipped none.
#: The gates set it; a run of a few files leaves it unset.
REQUIRE_ENV = "DELPHI_REQUIRE_CONFORMANCE"


def conformance_problems(expected, collected, skipped, harness_id) -> list[str]:
    """
    A5's verdict, in words. `collected` maps each kit test (`test_<module>.py::<test>`)
    to the harness ids its cases were collected on; `skipped` holds each kit test
    one of whose cases was skipped.
    """
    problems = [f"not collected on {harness_id!r}: {test}" for test in expected
                if harness_id not in collected.get(test, ())]
    problems += [f"skipped: {test}" for test in sorted(skipped)]
    return problems


class RequireConformance:
    """The pytest plugin behind `require_conformance`: records what ran, and judges it at the end."""

    def __init__(self, harness_id: str, expected=None, prefix: str = __name__ + "."):
        self.harness_id, self.prefix = harness_id, prefix
        self.expected = TESTS if expected is None else tuple(expected)
        self.collected: dict[str, set] = {}
        self.nodes: dict[str, str] = {}
        self.skipped: set[str] = set()
        self.problems: list[str] = []

    def key(self, item):
        """`test_<module>.py::<test>` for a case of a kit test, else None."""
        module = getattr(getattr(item, "function", None), "__module__", None) or ""
        return f"{item.path.name}::{item.originalname}" if module.startswith(self.prefix) else None

    @pytest.hookimpl(trylast=True)
    def pytest_collection_finish(self, session):
        for item in session.items:
            key = self.key(item)
            if key is None:
                continue
            callspec = getattr(item, "callspec", None)
            harness = callspec.params.get("store_harness") if callspec else None
            self.collected.setdefault(key, set()).add(getattr(harness, "id", None))
            self.nodes[item.nodeid] = key

    def pytest_runtest_logreport(self, report):
        if report.skipped and report.nodeid in self.nodes:
            self.skipped.add(self.nodes[report.nodeid])

    @pytest.hookimpl(trylast=True)
    def pytest_sessionfinish(self, session, exitstatus):
        self.problems = conformance_problems(self.expected, self.collected, self.skipped, self.harness_id)
        if not self.problems:
            return
        reporter = session.config.pluginmanager.get_plugin("terminalreporter")
        lines = [f"conformance ({REQUIRE_ENV}={self.harness_id}): {problem}" for problem in self.problems]
        for line in lines:
            reporter.write_line(line, red=True) if reporter else print(line)
        session.exitstatus = pytest.ExitCode.TESTS_FAILED


def require_conformance(config) -> RequireConformance | None:
    """
    Call from the consumer's `pytest_configure`. When `DELPHI_REQUIRE_CONFORMANCE`
    names a harness, the run fails unless every test in `TESTS` was collected on
    it and none was skipped (A5), whatever else passed.
    """
    import os

    harness_id = os.environ.get(REQUIRE_ENV, "").strip()
    if not harness_id:
        return None
    plugin = RequireConformance(harness_id)
    config.pluginmanager.register(plugin, "delphi-require-conformance")
    return plugin
