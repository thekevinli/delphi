"""A8 · the public repository names nothing private: no tracked file holds a name from a private list.

Plan 4 §2.4 rule 11. The list of private names (cloud project, buckets, hostnames,
invite codes, ...) is itself private: it lives outside the public repository and
is passed as an argument, never committed to the checkout it scans. The check
fails if it is.

    python -m delphi_core_testkit.abstraction private-names --names FILE [--root DIR] [--show-names]

The list holds one name per line; blank lines and lines starting with `#` are
skipped, and a name shorter than three characters is refused (it would match
nearly everything). Each name is matched as a fixed string, ignoring ASCII case,
anywhere in a tracked file's path or contents, binary files included, as they are
in the working tree. Untracked files are not read.

A finding names the file, the line and the list's entry by its line number in the
list; a name inside a file's path is reported as "in a path", since the path would
spell it. The name and that path are printed only with `--show-names`, so the
check's own output never spreads what it guards, whatever log it lands in.
"""
import argparse
from pathlib import Path
import subprocess
import sys

MINIMUM = 3


def read_names(text, name="the list"):
    """([(line number, name)], problems) from a list file's text."""
    names, problems = [], []
    for number, raw in enumerate(text.splitlines(), 1):
        entry = raw.strip()
        if not entry or entry.startswith("#"):
            continue
        if len(entry) < MINIMUM:
            problems.append(f"{name}:{number}: a name shorter than {MINIMUM} characters would match nearly everything")
            continue
        names.append((number, entry))
    if not names and not problems:
        problems.append(f"{name} holds no names, so the scan would check nothing")
    return names, problems


def tracked_files(root):
    result = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"git ls-files failed in {root}: {result.stderr.decode(errors='replace').strip()}")
    return [path.decode() for path in result.stdout.split(b"\0") if path]


def scan(root, names):
    """[(path, line, list line number)] for each private name in a tracked file's path or contents.

    Line 0 means the file's path holds the name.
    """
    root = Path(root)
    needles = [(number, entry.lower().encode()) for number, entry in names]
    hits = []
    for relative in tracked_files(root):
        lowered_path = relative.lower().encode()
        hits += [(relative, 0, number) for number, needle in needles if needle in lowered_path]
        path = root / relative
        if path.is_symlink():
            data = str(path.readlink()).encode()
        elif path.is_file():
            data = path.read_bytes()
        else:
            continue  # deleted from the working tree, or a submodule
        lowered = data.lower()
        for number, needle in needles:
            at = lowered.find(needle)
            while at != -1:
                hits.append((relative, lowered.count(b"\n", 0, at) + 1, number))
                at = lowered.find(needle, at + 1)
    return sorted(set(hits))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="abstraction private-names", description=__doc__.split("\n")[0])
    parser.add_argument("--names", type=Path, required=True, help="the private list, kept outside the checkout")
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="the checkout to scan (default: here)")
    parser.add_argument("--show-names", action="store_true", help="print each name found, not only its entry")
    args = parser.parse_args(argv)

    top = subprocess.run(["git", "-C", str(args.root), "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    if top.returncode != 0:
        print(f"private names: {args.root} is not a git checkout", file=sys.stderr)
        return 2
    root = Path(top.stdout.strip()).resolve()
    names, problems = read_names(args.names.read_text(), args.names.name)
    listed = args.names.resolve()
    if listed.is_relative_to(root) and listed.relative_to(root).as_posix() in tracked_files(root):
        problems.append(f"{args.names.name} is tracked by the checkout it scans; the list must never be committed")
    by_number = dict(names)
    hits = scan(root, names) if names else []
    for path, line, number in hits:
        where = f"{path}:{line}" if line else (f"{path} (its path)" if args.show_names else "in a path")
        shown = f": {by_number[number]}" if args.show_names else ""
        print(f"private name: {where}: entry on line {number} of {args.names.name}{shown}", file=sys.stderr)
    for line in problems:
        print(f"FAIL: {line}", file=sys.stderr)
    print(f"private names: {len(names)} names over the tracked files of {root.name}; "
          f"{len(hits)} found, {len(problems)} problems.")
    return 1 if hits or problems else 0


if __name__ == "__main__":
    sys.exit(main())
