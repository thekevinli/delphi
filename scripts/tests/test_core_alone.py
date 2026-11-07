"""A2 must fail on what only a clean install can see, and run only where nothing can reach the checkout.

The whole of A2 (`scripts/core_alone.sh`) builds two wheels, makes a venv and
runs core's suite, so it runs in the full `check.sh` and in `ci_core.sh`. These
cases hold its pieces: the probe's verdicts on planted modules, the refusal to
run inside a checkout, and where the gates call it.
"""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

SCRIPTS = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("core_alone", SCRIPTS / "core_alone.py")
alone = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(alone)


def test_a_core_module_loaded_from_outside_the_venv_is_named(tmp_path):
    venv, checkout = tmp_path / "venv", tmp_path / "checkout"
    modules = {
        "delphi_core": SimpleNamespace(__file__=str(venv / "delphi_core/__init__.py")),
        "delphi_core.app": SimpleNamespace(__file__=str(checkout / "core/delphi_core/app.py")),
        "delphi_core_testkit": SimpleNamespace(__file__=str(checkout / "core/testkit/delphi_core_testkit/__init__.py")),
        "json": SimpleNamespace(__file__=str(checkout / "json.py")),
    }
    assert alone.outside(modules, venv) == [
        f"delphi_core.app: {checkout / 'core/delphi_core/app.py'}",
        f"delphi_core_testkit: {checkout / 'core/testkit/delphi_core_testkit/__init__.py'}",
    ]


def test_a_core_module_that_needs_an_undeclared_package_is_named(tmp_path, monkeypatch):
    """Planted: an import a developer's environment satisfies and core's wheel does not declare."""
    package = tmp_path / "w3a_alone_core"
    (package / "inner").mkdir(parents=True)
    (package / "__init__.py").write_text("")
    (package / "inner/__init__.py").write_text("")
    (package / "inner/fine.py").write_text("import json\n")
    (package / "inner/planted.py").write_text("import w3a_not_installed_anywhere\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    try:
        imported, failures = alone.import_everything("w3a_alone_core")
    finally:
        for name in [name for name in sys.modules if name.startswith("w3a_alone_core")]:
            del sys.modules[name]
    assert "w3a_alone_core.inner.fine" in imported
    assert failures == ["w3a_alone_core.inner.planted: ModuleNotFoundError: "
                        "No module named 'w3a_not_installed_anywhere'"]


def test_a_run_inside_a_git_checkout_is_refused(tmp_path):
    """From inside a checkout, `git rev-parse --show-toplevel` would find it: the run stops before the venv."""
    checkout = tmp_path / "checkout"
    (checkout / "tmp").mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(checkout)], check=True, capture_output=True)
    dist = tmp_path / "dist"
    dist.mkdir()
    for name in ("delphi_core-0.0.1-py3-none-any.whl", "delphi_core_testkit-0.0.1-py3-none-any.whl"):
        (dist / name).write_text("not built")
    result = subprocess.run(["bash", str(SCRIPTS / "core_alone.sh"), str(dist)], capture_output=True, text=True,
                            env={**os.environ, "TMPDIR": str(checkout / "tmp"), "CORE_ALONE_PY": "false"}, timeout=60)
    assert result.returncode == 1
    assert "lies inside a git checkout" in result.stderr


def test_the_full_check_runs_core_alone_and_the_core_check_does_not():
    check = (SCRIPTS.parent / "check.sh").read_text()
    assert '"") run_alone=1 ;;' in check and "--core) run_parity=0; run_ours=0 ;;" in check
    gated = check[check.index("if [[ $run_alone == 1 ]]"):check.index("if [[ $run_parity == 1 ]]")]
    assert 'scripts/core_alone.sh" "$wheels/dist"; } || failures+=("core alone")' in gated
    assert 'scripts/core_alone.sh "$OUT/dist"' in (SCRIPTS / "ci_core.sh").read_text()
