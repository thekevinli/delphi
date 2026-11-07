"""The vocabulary gate: "knowledge" stays out of the tree except where a line says why.

Plan 4's Stage 5 renamed the feature Memory. What may still say "knowledge" is a
name old data carries (a stored key, a filing version, a table an earlier revision
created), the code and the tests that read such a name, a retired name quoted in
history or asserted gone, a name the model receives (R1), or the English word.
Each of those is an entry in `ALLOWLIST` below; any other use fails the gate.

    python scripts/check_vocabulary.py                      # the tracked tree, ALLOWLIST
    python scripts/check_vocabulary.py --root DIR --allowlist FILE

An entry is `path glob : line regex : reason`, one per line; `#` starts a comment.
- The glob is matched against the path from the repository root: `**` crosses
  directories, `*` and `?` stay within one, and `{a,b}` is one entry per
  alternative.
- The regex is Python's, case-sensitive, and runs over the line. An occurrence of
  the word is explained only when a match of the regex contains it, so an entry
  pins the literal it is about and a second "knowledge" on the same line is judged
  on its own.
- The reason is everything after the last " : ", and it is required.
- An entry, or one alternative of a braced glob, that explains nothing fails the
  gate, so the list cannot rot: when a name finally goes, its entry goes with it.

Prefer a regex that names the literal over a whole file. `.*` is for files nobody
edits: earlier revisions, `defaults.py`, recorded data and licence texts.

The word is matched case-insensitively, inside identifiers too (`useKnowledge`),
except as part of "acknowledge". Tracked files are read as they are in the working
tree; untracked and binary files are not read.
"""
import argparse
from dataclasses import dataclass
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
WORD = re.compile(r"(?<!ac)knowledge", re.IGNORECASE)
SEPARATOR = " : "

# L1-L21 are the legacy sites of W10's analysis (Plan 4, Stage 5); R1-R20 the
# owner's decisions on it.
ALLOWLIST = r"""
# Never edited, so allowed whole.
core/delphi_core/defaults.py : .* : L21: byte-frozen, because revision f7a3c19d5e84 compares a project's SKILLS.md with it exactly
core/tests/data/golden/local/** : .* : recorded data: the library 0.6.9 wrote, kept as written
core/tests/data/golden/manifest.json : "knowledgeVersion" : recorded data: the manifest 0.6.9 wrote beside its library
core/tests/data/model-inputs/** : .* : recorded data: byte for byte what the model receives (R1 and English)
desktop/frontend/tests/fixtures/recorded-answers.json : .* : recorded data: answers models wrote, kept as written; the word is English and in paper titles
desktop/build/licenses/** : .* : third-party licence texts, verbatim

# The model receives these (M1-M14). Renamed, if ever, in one deliberate commit that
# regenerates the model-input goldens, and this entry then matches nothing.
** : reader_knowledge_index|knowledge_(?:audit|reorganization|page_rewrite(?:_check)?)\b|Knowledge(?:Audit|Quote|Contradiction|Move|Reorganization)\b|knowledge_health\.py|re-filing one reader's knowledge base|consulting the knowledge|no knowledge pages yet : R1: a name or text the model receives

** : background knowledge|outside knowledge|no knowledge of|[Kk]nowledge[- ]distillation : English: the word, not the feature

# Stored names that stay, and the code that reads an old one.
core/delphi_core/storage/base.py : f"knowledge/u/ : L4 (R2): the object-key prefix every stored figure and capture record names
core/delphi_core/storage/base.py : = "knowledge-base" : L5 (R4): the key old account-chat images and sidecars are filed under
core/delphi_core/storage/base.py : = "knowledge-v6" : L6 (R3): the stored filing version; a new value refiles every document
core/public-surface.txt : = 'knowledge-v6'|= 'knowledge-base' : L5, L6: the surface (A3) renders the two stored values above
core/delphi_core/storage/local.py : parts\[0\] == "knowledge" : L4 (R2): a stored object key under knowledge/u/ maps to the account's directory
core/delphi_core/storage/local_format.py : "knowledge"|knowledge/|a file named `knowledge`|knowledge\.format-[124]|knowledgeUpdate|knowledge_base_chat|_IN_KNOWLEDGE\b|\bknowledge(?= / | = |\.is_dir\(\)|, |\)|: Path) : L3: formats 1 to 4 run in an old store's knowledge/ and keep their copies beside it
core/delphi_core/backfill/memory_{eval,judge}.py : "knowledge"|knowledge/ : L7: a frozen candidate archive holds users/<u>/knowledge/, read as files and never migrated
core/delphi_core/config.py : "KNOWLEDGE_[A-Z_]+": "MEMORY_|when Knowledge became Memory : L9: Settings refuse each retired environment name and name its replacement
desktop/frontend/app/lib/layout-cache.ts : "delphi:knowledge-layout:" : L8: the sweep also clears layouts cached under the former prefix
{desktop/frontend/worker/index.ts,desktop/tests/worker-host.test.mts,desktop/tests/memory-journey.test.mts,desktop/frontend/tests/browser/memory.spec.ts} : /knowledge-base : L16: an old /knowledge-base bookmark redirects to /memory with its query
core/{CLAUDE,AGENTS}.md : knowledge\.format-[124]|a file named `knowledge`|`knowledge/format\.json` before format 5|`knowledge/` renamed|`knowledgeUpdate`|`knowledge_base_chat` kind : L3: the directories formats 2 and 3 kept an account's Memory in, as stored
desktop/frontend/app/components/DocumentFiling.tsx : "not in your Knowledge yet, file it now"|your Knowledge" sentence : R17: the filing card's old wording, quoted as the history that explains the four states

# Tests that feed an old name, or assert it gone, and check what Delphi does today.
{core/tests,core/testkit,desktop/frontend/tests}/** : knowledge-v[1-6] : L10 (R3): filing versions as stored, older ones on purpose
{core/tests,core/testkit}/** : knowledge/u/|"objectKey": "knowledge/ : L4 (R2): object keys as stored
desktop/tests/memory-journey.test.mts : objectKey: `knowledge/u/ : L4 (R2): a capture record written as the store writes it
core/tests/test_memory_retirement.py : "knowledge"|knowledge/|knowledge_base_chat|\bknowledge(?= [/=] ) : L3, L18: stores built in the old layout, before the step that retires them
core/tests/test_format_five.py : .* : L18: stores built at format 4 and before, in the old names, which the step to format 5 renames
core/tests/test_plans.py : "knowledge"|`knowledge/` : L3: a format-3 store, in the old layout
core/tests/test_golden_memory.py : "knowledge"|knowledge/ : the golden local library, written by 0.6.9 at format 4 in the old layout
core/tests/test_memory_{eval,judge}.py : "knowledge"|knowledge/ : L7: candidate archives in the old layout
core/tests/test_legacy_names.py : knowledge-base : L5: the old account-chat image key
core/tests/test_model_tasks.py : knowledge\.(?:author|verify|ingest_verify|ingest)\b|knowledge_(?:author_model|verifier_model|document_verifier_reasoning_effort|combined_authoring_enabled|plan_attempts|render_attempts) : L11: retired task keys and settings asserted gone
core/tests/test_prompts.py : (?:write|open|grep|read)_knowledge|knowledge_links|knowledge_persona|knowledge (?:record|page|base) : L12: retired tools, tag and words asserted absent from what the model is told
core/tests/test_chat.py : (?:write|search|read)_knowledge : L13: retired tools asserted not offered
{core/tests/test_harness_loop,core/testkit/delphi_core_testkit/provider}.py : write_knowledge : L14: a model trained on older prompts calls the retired write tool
core/tests/test_e2e_provider.py : knowledge_(?:document_authoring_v1|page_plan|document_verification_v1|content_verification|update)\b : L15: retired structured-output names the fake provider refuses
core/tests/{wheel_smoke,build_golden}.py : "KNOWLEDGE_" : L17: an older release's wheel still reads the retired names, so its run strips them
core/tests/test_retired_env.py : KNOWLEDGE_[A-Z_]+|knowledge_max_pages|when Knowledge became Memory : L9: each retired environment name is refused
desktop/frontend/tests/layout-cache.test.mts : delphi:knowledge-layout: : L8: layouts cached under the former prefix are swept
desktop/frontend/tests/rendered-html.test.mjs : account-knowledge-card|id: "knowledge" : L19: a retired class and settings pane asserted gone
desktop/frontend/tests/dashboard.test.mts : is-knowledge : L19: a retired class asserted gone

# The gate itself.
scripts/check_vocabulary.py : .* : the gate: its allowlist names the word it keeps out
scripts/tests/test_vocabulary_gate.py : .* : the gate's tests plant the word in trees of their own
"""


@dataclass
class Entry:
    text: str
    path: re.Pattern
    line: re.Pattern
    used: bool = False


def expand_braces(glob):
    """`a/{b,c}.py` is `a/b.py` and `a/c.py`; nested or repeated braces expand in turn."""
    brace = re.search(r"\{([^{}]*)\}", glob)
    if not brace:
        return [glob]
    head, tail = glob[:brace.start()], glob[brace.end():]
    return [expanded for option in brace.group(1).split(",") for expanded in expand_braces(head + option + tail)]


def glob_pattern(glob):
    parts, at = [], 0
    while at < len(glob):
        if glob.startswith("**/", at):
            parts.append("(?:.*/)?")
            at += 3
        elif glob.startswith("**", at):
            parts.append(".*")
            at += 2
        elif glob[at] == "*":
            parts.append("[^/]*")
            at += 1
        elif glob[at] == "?":
            parts.append("[^/]")
            at += 1
        else:
            parts.append(re.escape(glob[at]))
            at += 1
    return re.compile("".join(parts))


def read_allowlist(text, name):
    entries, problems = [], []
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        glob, first, rest = line.partition(SEPARATOR)
        regex, second, reason = rest.rpartition(SEPARATOR)
        if not (first and second and glob.strip() and regex.strip() and reason.strip()):
            problems.append(f"{name}:{number}: not `path glob : line regex : reason`: {line}")
            continue
        try:
            pattern = re.compile(regex.strip())
        except re.error as error:
            problems.append(f"{name}:{number}: the regex does not compile ({error}): {regex.strip()}")
            continue
        for one in expand_braces(glob.strip()):
            entries.append(Entry(f"{one} : {regex.strip()}", glob_pattern(one), pattern))
    return entries, problems


def lines_naming_the_word(root):
    """(path, line number, text) for each line of a tracked text file holding the word.

    `git grep` finds the candidates as a fixed string, so no PCRE build is needed;
    WORD then decides, which is where "acknowledge" drops out.
    """
    command = ["git", "-C", str(root), "grep", "-I", "-i", "-n", "-z", "-F",
               "--no-color", "--no-column", "-e", "knowledge", "--", "."]
    result = subprocess.run(command, capture_output=True)
    if result.returncode not in (0, 1):
        sys.exit(f"vocabulary gate: git grep failed in {root}: {result.stderr.decode(errors='replace').strip()}")
    for record in result.stdout.split(b"\n"):
        if record:
            path, number, text = record.split(b"\0", 2)
            yield path.decode(), int(number), text.decode("utf-8", errors="replace").rstrip("\r")


def unexplained(path, text, entries):
    """The offsets of the occurrences no entry explains; marks the entries that explain one."""
    spans = [(entry, found.span()) for entry in entries if entry.path.fullmatch(path)
             for found in entry.line.finditer(text)]
    missed = []
    for word in WORD.finditer(text):
        start, end = word.span()
        explaining = [entry for entry, (left, right) in spans if left <= start and end <= right]
        for entry in explaining:
            entry.used = True
        if not explaining:
            missed.append(start)
    return missed


def excerpt(text, start, width=200):
    text = text.strip()
    if len(text) <= width:
        return text
    start = max(0, min(start - width // 3, len(text) - width))
    return ("…" if start else "") + text[start:start + width] + ("…" if start + width < len(text) else "")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--root", type=Path, default=ROOT, help="the repository's top directory")
    parser.add_argument("--allowlist", type=Path, help="a file of entries to use instead of ALLOWLIST")
    args = parser.parse_args(argv)
    if args.allowlist:
        entries, problems = read_allowlist(args.allowlist.read_text(), args.allowlist.name)
    else:
        entries, problems = read_allowlist(ALLOWLIST, "ALLOWLIST")

    lines, files, failing = 0, set(), []
    for path, number, text in lines_naming_the_word(args.root.resolve()):
        if not WORD.search(text):
            continue
        lines += 1
        files.add(path)
        missed = unexplained(path, text, entries)
        if missed:
            failing.append(f"{path}:{number}: {excerpt(text, missed[0])}")
    stale = [f"matches nothing; remove it: {entry.text}" for entry in entries if not entry.used]

    for line in failing:
        print(f"unexplained: {line}", file=sys.stderr)
    for line in problems + stale:
        print(f"FAIL: {line}", file=sys.stderr)
    print(f"vocabulary gate: {lines} lines in {len(files)} files name the word; "
          f"{len(failing)} unexplained, {len(stale)} stale entries, {len(problems)} unreadable.")
    return 1 if failing or stale or problems else 0


if __name__ == "__main__":
    sys.exit(main())
