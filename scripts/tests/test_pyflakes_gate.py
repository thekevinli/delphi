"""The pyflakes gate must fail on what a rename breaks and on nothing it only reports.

Each case plants a file in a tree of its own and runs the shipped script as a
process, because the exit status is what `scripts/check.sh` acts on.
"""
from pathlib import Path
import subprocess
import sys


SCRIPTS = Path(__file__).resolve().parents[1]
GATE = SCRIPTS / "check_pyflakes.py"


def gate(tmp_path, source, allowlist=None):
    (tmp_path / "pkg").mkdir(exist_ok=True)
    (tmp_path / "pkg" / "planted.py").write_text(source)
    list_file = tmp_path / "allowlist.txt"
    list_file.write_text(allowlist or "")
    return subprocess.run(
        [sys.executable, str(GATE), str(tmp_path / "pkg"), "--root", str(tmp_path), "--allowlist", str(list_file)],
        capture_output=True, text=True, timeout=60,
    )


def test_an_undefined_name_fails_the_gate(tmp_path):
    result = gate(tmp_path, "def kept():\n    return renamed_helper(1)\n")
    assert result.returncode == 1
    assert "pkg/planted.py:2" in result.stderr and "undefined name 'renamed_helper'" in result.stderr


def test_an_undefined_name_in_a_branch_no_test_reaches_fails_the_gate(tmp_path):
    result = gate(tmp_path, "def kept(flag):\n    if flag:\n        return 1\n    return missing.value\n")
    assert result.returncode == 1 and "undefined name 'missing'" in result.stderr


def test_a_name_read_before_the_assignment_that_makes_it_local_fails_the_gate(tmp_path):
    result = gate(tmp_path, "value = 1\n\n\ndef kept():\n    print(value)\n    value = 2\n")
    assert result.returncode == 1 and "referenced before assignment" in result.stderr


def test_a_name_exported_but_never_defined_fails_the_gate(tmp_path):
    result = gate(tmp_path, "__all__ = ['gone']\n")
    assert result.returncode == 1 and "undefined name 'gone' in __all__" in result.stderr


def test_a_redefinition_of_an_unused_name_fails_the_gate(tmp_path):
    result = gate(tmp_path, "def twice():\n    return 1\n\n\ndef twice():\n    return 2\n")
    assert result.returncode == 1 and "redefinition of unused 'twice'" in result.stderr


def test_a_parameter_shadowing_an_unused_import_fails_the_gate(tmp_path):
    result = gate(tmp_path, "from os import path\n\n\ndef kept(path):\n    return path\n")
    assert result.returncode == 1 and "redefinition of unused 'path'" in result.stderr


def test_a_file_that_cannot_be_parsed_fails_the_gate(tmp_path):
    result = gate(tmp_path, "def broken(:\n")
    assert result.returncode == 1 and "unreadable" in result.stderr


def test_other_warnings_are_reported_and_do_not_fail_the_gate(tmp_path):
    result = gate(tmp_path, "import os\n\n\ndef kept():\n    unused = 1\n    return f'plain'\n")
    assert result.returncode == 0
    assert "warning:" in result.stdout and "'os' imported but unused" in result.stdout
    assert "'unused' is assigned to but never used" in result.stdout


def test_a_default_path_that_is_gone_stops_the_gate_rather_than_checking_less(tmp_path):
    """The package renamed and the default not: the gate would check only the tests and pass."""
    (tmp_path / "core" / "tests").mkdir(parents=True)
    (tmp_path / "core" / "tests" / "test_kept.py").write_text("def test_kept():\n    assert True\n")
    result = subprocess.run([sys.executable, str(GATE), "--root", str(tmp_path)], capture_output=True, text=True, timeout=60)
    assert result.returncode == 2 and "no such path" in result.stderr and "core/delphi_core" in result.stderr


def test_a_clean_tree_passes(tmp_path):
    result = gate(tmp_path, "def kept():\n    return 1\n")
    assert result.returncode == 0 and "0 failing" in result.stdout


REDEFINITION = "def twice():\n    return 1\n\n\ndef twice():\n    return 2\n"
ENTRY = "pkg/planted.py: redefinition of unused 'twice'  # kept while the second replaces the first on purpose\n"


def test_an_allowlisted_finding_is_reported_and_passes(tmp_path):
    result = gate(tmp_path, REDEFINITION, ENTRY)
    assert result.returncode == 0 and "allowed: pkg/planted.py" in result.stdout


def test_an_allowlist_entry_survives_the_line_moving(tmp_path):
    result = gate(tmp_path, "\n\n\n" + REDEFINITION, ENTRY)
    assert result.returncode == 0


def test_an_allowlist_entry_for_another_name_does_not_excuse_this_one(tmp_path):
    result = gate(tmp_path, REDEFINITION, ENTRY.replace("twice", "other"))
    assert result.returncode == 1
    assert "redefinition of unused 'twice'" in result.stderr and "matches nothing" in result.stderr


def test_an_allowlist_entry_that_matches_nothing_fails_the_gate(tmp_path):
    result = gate(tmp_path, "def kept():\n    return 1\n", ENTRY)
    assert result.returncode == 1 and "matches nothing" in result.stderr


def test_an_allowlist_entry_without_a_reason_fails_the_gate(tmp_path):
    result = gate(tmp_path, REDEFINITION, "pkg/planted.py: redefinition of unused 'twice'\n")
    assert result.returncode == 1 and "no reason" in result.stderr


def test_the_backend_check_runs_the_gate_and_counts_its_failure():
    check = (SCRIPTS.parent / "check.sh").read_text()
    backend = check[check.index("if [[ $run_core == 1 ]]"):check.index("if [[ $run_parity == 1 ]]")]
    assert 'check_pyflakes.py" || failures+=(' in backend
