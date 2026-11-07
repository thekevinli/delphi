"""The gates run every layering check, and a failing one fails them.

`scripts/layering.sh` is run here with a stand-in interpreter that records each
check it is asked for and fails the one a case names, so what is tested is the
wiring: which checks run, on what, and that one failure is enough. Each check's
own verdicts are tested in core's `tests/test_abstraction_checks.py`.
"""
import os
from pathlib import Path
import subprocess

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
LAYERING = SCRIPTS / "layering.sh"
CHECKS = ("imports", "surface", "http", "settings", "versions", "private-names")


def layering(tmp_path, failing=None, names=None):
    """layering.sh over this checkout with a recording interpreter; (result, the checks it ran)."""
    record = tmp_path / "ran.txt"
    stand_in = tmp_path / "python"
    stand_in.write_text("#!/bin/sh\n"
                        f'echo "$*" >> "{record}"\n'
                        f'case "$*" in *"abstraction {failing} "*) exit 1;; esac\n'
                        "exit 0\n")
    stand_in.chmod(0o755)
    env = {key: value for key, value in os.environ.items() if key != "DELPHI_PRIVATE_NAMES"}
    if names is not None:
        env["DELPHI_PRIVATE_NAMES"] = str(names)
    result = subprocess.run(["bash", str(LAYERING), str(stand_in)], capture_output=True, text=True, env=env, timeout=60)
    ran = record.read_text().splitlines() if record.exists() else []
    return result, ran


def test_every_check_runs_from_the_kit_over_core_and_the_desktop_layer(tmp_path):
    result, ran = layering(tmp_path, names=tmp_path / "names.txt")
    assert result.returncode == 0, result.stderr
    assert [line.split()[2] for line in ran] == list(CHECKS)
    assert all(line.startswith("-m delphi_core_testkit.abstraction ") for line in ran)
    imports, surface, http, settings, versions, private = ran
    assert "--package core/delphi_core --package desktop/backend/delphi_desktop" in imports
    assert "--exceptions core/abstraction-exceptions.txt --require-empty" in imports
    assert surface.endswith("surface check --snapshot core/public-surface.txt")
    assert "--reference delphi_core.main:app --product delphi_desktop.main:app" in http
    assert settings.endswith("settings --discover delphi_desktop")
    for project in ("core/pyproject.toml", "core/testkit/pyproject.toml", "desktop/backend/pyproject.toml"):
        assert f"--pyproject {project}" in versions
    assert "--package-json desktop/package.json --package-lock desktop/package-lock.json" in versions
    assert f"--names {tmp_path / 'names.txt'}" in private


@pytest.mark.parametrize("failing, name", [
    ("imports", "A1 imports"), ("surface", "A3 surface"), ("http", "A4 http"),
    ("settings", "A6 settings"), ("versions", "A7 versions"), ("private-names", "A8 private names"),
])
def test_one_failing_check_fails_the_script_and_is_named(tmp_path, failing, name):
    result, ran = layering(tmp_path, failing=failing, names=tmp_path / "names.txt")
    assert result.returncode == 1
    assert f"layering: FAILED: {name}" in result.stderr
    assert len(ran) == len(CHECKS), "a failure does not stop the checks after it"


def test_without_the_private_list_a8_says_it_was_skipped(tmp_path):
    result, ran = layering(tmp_path)
    assert result.returncode == 0, result.stderr
    assert "A8 private names: skipped: no list" in result.stdout
    assert not [line for line in ran if " private-names " in f"{line} "]


def test_the_core_check_runs_layering_the_scripts_suite_and_requires_conformance():
    check = (SCRIPTS.parent / "check.sh").read_text()
    core = check[check.index("if [[ $run_core == 1 ]]"):check.index("if [[ $run_parity == 1 ]]")]
    assert 'scripts/layering.sh" "$CORE_PY" || failures+=(' in core
    assert "DELPHI_REQUIRE_CONFORMANCE=local" in core
    assert 'cd "$ROOT_DIR/scripts" && "$CORE_PY" -m pytest' in core


def test_core_ci_runs_layering_core_alone_and_the_surface_classification():
    ci = (SCRIPTS / "ci_core.sh").read_text()
    for needed in ('scripts/layering.sh "$PY312"', "scripts/core_alone.sh", "backend_release.py surface",
                   "DELPHI_REQUIRE_CONFORMANCE=local"):
        assert needed in ci, needed
