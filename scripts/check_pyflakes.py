"""The backend's static name check: pyflakes, failing on what a rename breaks.

A name that no test reaches is a name nothing checks, and a rename that misses one
shows only when that line runs in production. pyflakes reads every line whether or
not a test does, so the two findings it can make with no false alarm fail the gate:
an undefined name (a rename's usual casualty) and a redefinition of an unused one
(a second definition silently replacing the first, so the first never runs).
Everything else it says - unused imports and variables, mostly - is printed and
does not fail: those are tidiness, and failing on them would teach everyone to
skip the step.

    python scripts/check_pyflakes.py                    # core/delphi_core, core/tests, core/testkit, desktop/backend
    python scripts/check_pyflakes.py PATH... [--root DIR] [--allowlist FILE]

`scripts/pyflakes-allowlist.txt` names the failing findings that stay, each with
its reason. An entry that no longer matches anything fails too, so the list can
only shrink. Findings are matched by file and message with the line numbers left
out, because a line number rots the moment someone edits above it.

Kinds are chosen by pyflakes' own message class, never by its wording. A file
pyflakes cannot read or parse fails: a file the gate did not check is not a file
it passed.
"""
import argparse
from pathlib import Path
import re
import sys

try:
    from pyflakes import api, messages
except ImportError:
    sys.exit("pyflakes is not installed; `bash scripts/core-env.sh` installs it.")

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PATHS = ("core/delphi_core", "core/tests", "core/testkit", "desktop/backend", "scripts")
DEFAULT_ALLOWLIST = ROOT / "scripts" / "pyflakes-allowlist.txt"

# UndefinedLocal is the same mistake inside a function: a name read before the
# assignment that makes it local.
FAILING = (
    messages.UndefinedName,
    messages.UndefinedExport,
    messages.UndefinedLocal,
    messages.RedefinedWhileUnused,
)


LINE_REFERENCE = re.compile(r" from line \d+")


class Findings:
    """The reporter pyflakes calls; it keeps messages as objects, not text."""

    def __init__(self):
        self.messages = []
        self.unreadable = []

    def flake(self, message):
        self.messages.append(message)

    def syntaxError(self, filename, msg, lineno, offset, text):
        self.unreadable.append(f"{filename}:{lineno}: {msg}")

    def unexpectedError(self, filename, msg):
        self.unreadable.append(f"{filename}: {msg}")


def relative(message, root):
    path = Path(message.filename)
    try:
        path = path.resolve().relative_to(root)
    except ValueError:
        pass
    return path.as_posix()


def words(message):
    return message.message % message.message_args


def key(message, root):
    """`path: message` with the line numbers out, the form the allowlist uses."""
    return f"{relative(message, root)}: {LINE_REFERENCE.sub('', words(message))}"


def read_allowlist(path):
    """Entries are `path: message  # reason`; a missing reason is an error."""
    entries, problems = {}, []
    if not path.exists():
        return entries, problems
    for number, line in enumerate(path.read_text().splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        entry, _, reason = line.partition(" # ")
        if not reason.strip():
            problems.append(f"{path.name}:{number}: no reason after ' # ': {entry}")
        entries[entry.strip()] = number
    return entries, problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("paths", nargs="*", help="files or directories (default: core/delphi_core core/tests core/testkit desktop/backend)")
    parser.add_argument("--root", type=Path, default=ROOT, help="paths are shown, and allowlisted, relative to this")
    parser.add_argument("--allowlist", type=Path, default=DEFAULT_ALLOWLIST)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    paths = args.paths or [str(root / path) for path in DEFAULT_PATHS]
    if missing := [path for path in paths if not Path(path).exists()]:
        print(f"pyflakes gate: no such path: {', '.join(missing)}", file=sys.stderr)
        return 2

    findings = Findings()
    files = list(api.iterSourceCode(paths))
    for filename in files:
        api.checkPath(filename, findings)
    if not files:
        print(f"pyflakes gate: no Python files under {', '.join(paths)}", file=sys.stderr)
        return 2

    allowed, problems = read_allowlist(args.allowlist)
    used = set()
    failing = []
    for message in sorted(findings.messages, key=lambda m: (m.filename, m.lineno, m.col)):
        shown = f"{relative(message, root)}:{message.lineno}:{message.col + 1}: {words(message)}"
        if not isinstance(message, FAILING):
            print(f"warning: {shown}")
        elif key(message, root) in allowed:
            used.add(key(message, root))
            print(f"allowed: {shown}")
        else:
            failing.append(shown)
    problems += [f"{args.allowlist.name}:{allowed[entry]}: matches nothing; remove it: {entry}"
                 for entry in allowed if entry not in used]

    for line in findings.unreadable:
        print(f"unreadable: {line}", file=sys.stderr)
    for line in failing:
        print(f"FAIL: {line}", file=sys.stderr)
    for line in problems:
        print(f"FAIL: {line}", file=sys.stderr)
    bad = len(failing) + len(problems) + len(findings.unreadable)
    print(f"pyflakes gate: {len(files)} files, {len(findings.messages)} findings, {bad} failing.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
