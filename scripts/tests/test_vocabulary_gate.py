"""The vocabulary gate must fail on a "knowledge" nobody explained, and on an explanation nothing needs.

Each case but the last two builds a git tree of its own and runs the shipped
script as a process, because the exit status is what `check.sh` acts on.
"""
from pathlib import Path
import subprocess
import sys

import pytest


SCRIPTS = Path(__file__).resolve().parents[1]
GATE = SCRIPTS / "check_vocabulary.py"


def gate(tmp_path, files, allowlist="", untracked=None):
    tree = tmp_path / "tree"
    tree.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(tree)], check=True, capture_output=True)
    for name, text in files.items():
        path = tree / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    subprocess.run(["git", "-C", str(tree), "add", "-A"], check=True, capture_output=True)
    for name, text in (untracked or {}).items():
        (tree / name).write_text(text)
    list_file = tmp_path / "allowlist.txt"
    list_file.write_text(allowlist)
    return subprocess.run(
        [sys.executable, str(GATE), "--root", str(tree), "--allowlist", str(list_file)],
        capture_output=True, text=True, timeout=60,
    )


STORED = 'MEMORY_VERSION = "knowledge-v6"\n'
ENTRY = 'app/base.py : = "knowledge-v6" : R3: the stored filing version\n'


def test_a_planted_word_in_a_new_file_fails_the_gate(tmp_path):
    result = gate(tmp_path, {"app/base.py": STORED, "app/new.py": "pages = 1\nfrom_the_knowledge_base = 2\n"}, ENTRY)
    assert result.returncode == 1
    assert "unexplained: app/new.py:2: from_the_knowledge_base = 2" in result.stderr
    assert "app/base.py" not in result.stderr


@pytest.mark.parametrize("spelling", [
    "the knowledge base", "Knowledge", "KNOWLEDGE_MAX_PAGES", "knowledge-base", "useKnowledgeGraph", "MemoKnowledgeBody",
])
def test_every_spelling_of_the_word_fails_the_gate(tmp_path, spelling):
    result = gate(tmp_path, {"app/new.ts": f"const x = '{spelling}';\n"})
    assert result.returncode == 1 and "app/new.ts:1" in result.stderr


def test_acknowledge_never_matches(tmp_path):
    result = gate(tmp_path, {"NOTICE.txt": "We acknowledge it.\nAcknowledged, unacknowledged: ACKNOWLEDGEMENTS\n"})
    assert result.returncode == 0, result.stderr
    assert "0 lines" in result.stdout


def test_an_allowlisted_line_passes(tmp_path):
    result = gate(tmp_path, {"app/base.py": STORED}, ENTRY)
    assert result.returncode == 0, result.stderr


def test_an_entry_explains_only_the_occurrence_its_regex_contains(tmp_path):
    result = gate(tmp_path, {"app/base.py": STORED.rstrip() + "  # the knowledge base's version\n"}, ENTRY)
    assert result.returncode == 1 and "unexplained: app/base.py:1" in result.stderr
    assert "matches nothing" not in result.stderr, "the entry still explained the occurrence it names"


def test_an_entry_for_another_file_does_not_excuse_this_one(tmp_path):
    result = gate(tmp_path, {"app/base.py": STORED}, ENTRY.replace("app/base.py", "app/other.py"))
    assert result.returncode == 1
    assert "unexplained: app/base.py:1" in result.stderr and "matches nothing; remove it: app/other.py" in result.stderr


def test_a_stale_entry_fails_the_gate(tmp_path):
    result = gate(tmp_path, {"app/base.py": 'MEMORY_VERSION = "memory-v7"\n'}, ENTRY)
    assert result.returncode == 1 and "matches nothing; remove it: app/base.py" in result.stderr


def test_each_alternative_of_a_braced_glob_must_explain_something(tmp_path):
    entry = 'app/{base,old}.py : = "knowledge-v6" : R3: the stored filing version\n'
    result = gate(tmp_path, {"app/base.py": STORED, "app/old.py": "pass\n"}, entry)
    assert result.returncode == 1 and "matches nothing; remove it: app/old.py" in result.stderr
    assert "app/base.py :" not in result.stderr


def test_two_stars_cross_directories_and_one_star_does_not(tmp_path):
    files = {"app/deep/base.py": STORED}
    assert gate(tmp_path / "two", files, ENTRY.replace("app/base.py", "app/**/*.py")).returncode == 0
    assert gate(tmp_path / "one", files, ENTRY.replace("app/base.py", "app/*.py")).returncode == 1


def test_an_entry_without_a_reason_fails_the_gate(tmp_path):
    result = gate(tmp_path, {"app/base.py": STORED}, 'app/base.py : = "knowledge-v6"\n')
    assert result.returncode == 1 and "not `path glob : line regex : reason`" in result.stderr


def test_an_entry_whose_regex_does_not_compile_fails_the_gate(tmp_path):
    result = gate(tmp_path, {"app/base.py": STORED}, "app/base.py : (knowledge : R3: unbalanced\n")
    assert result.returncode == 1 and "does not compile" in result.stderr


def test_only_tracked_files_are_read(tmp_path):
    result = gate(tmp_path, {"app/base.py": STORED}, ENTRY, untracked={"scratch.txt": "knowledge\n"})
    assert result.returncode == 0, result.stderr


def test_the_tree_passes_the_gate():
    """
    Red until every line the gate flags is settled: fixed, or allowlisted with a
    reason. The failure lists each one.
    """
    result = subprocess.run([sys.executable, str(GATE)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr + result.stdout


def test_the_core_check_runs_the_gate_and_counts_its_failure():
    check = (SCRIPTS.parent / "check.sh").read_text()
    core = check[check.index("if [[ $run_core == 1 ]]"):check.index("if [[ $run_parity == 1 ]]")]
    assert 'check_vocabulary.py" || failures+=(' in core
