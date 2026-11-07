"""
Is a Memory candidate's page set sound, and does it match the reviewed keys?

    backend/.venv/bin/python -m delphi_core.backfill.memory_eval formats
    backend/.venv/bin/python -m delphi_core.backfill.memory_eval keys   keys/*.json
    backend/.venv/bin/python -m delphi_core.backfill.memory_eval pages  --candidate <dir>
    backend/.venv/bin/python -m delphi_core.backfill.memory_eval edit   --before <dir> --after <dir> --slug position-encoding
    backend/.venv/bin/python -m delphi_core.backfill.memory_eval events --key keys/events.json --snapshots <dir>
    backend/.venv/bin/python -m delphi_core.backfill.memory_eval report --candidate <dir> --arm new --key keys/concepts.json --out eval/

The page-side evaluation rig; `chat_benchmark.py` is the answer side, and
`report --chat <its --out>` folds that rig's summary into this one. Everything
here is deterministic: it reads files and calls no model. The metrics that
need a judge model are `memory_judge`'s, and are only named here.

A **candidate** is a directory in the local store's layout: what
`memory_rebuild --stage` builds under `memory-rebuilds/<user>/<name>/`,
a data directory, or an archived account. Under `users/<user>/` it is read as:

    memory/pages/<slug>.json        one page: kind, title, aliases, body, citations
    memory/evidence.json            captured outside sources, by id
    memory/evidence/<id>.json       each one's extracted sections
    projects/<id>/meta.json         the documents, with their page counts
    projects/<id>/notes/<doc>.json  the reader's margin notes

A store before format 5 kept Memory in knowledge/ instead, and so do the
frozen candidates written then: the benchmark's reference arm, archived
accounts, older `--stage` builds. Each account is read from whichever of the
two it has (`memory_directory`), so one data root may hold both layouts; an
account holding both directories is refused, as the store refuses it.

The files are read as JSON and `LocalStorage` is never constructed: opening a
store runs its migrations, and a rig that scores the old arm must not rewrite
it first. Nor does anything here write to a candidate.

**Keys** are JSON files a person has reviewed (`formats` prints a complete
one). A file holds any of these sections, and several files are read as one:

| Section        | Holds |
|----------------|-------|
| `documents`    | the frozen corpus: a `key` the other sections use, and the stored `id` |
| `concepts`     | the concept inventory: an `id`, a `title` and `aliases` for every concept that must have a page |
| `mustNotSplit` | pairs of names (`first`, `second`: a concept id or a list of names) that are one idea and must not become two pages |
| `claims`       | gold claims per concept: `text`, `numbers` (`value`, `unit`, `condition`), `locator` (`document`, `page` or `section`) |
| `connections`  | per domain: `concepts` (`from` depends on `to`) and `sources` (`from` builds on, competes with, corrects or conflicts with `to`) |
| `events`       | the scripted sequence: per event its `type`, and `expect`, a list of `create`/`edit` of a concept; an empty list means nothing is filed |
| `associations` | per chat question: the concepts a good answer `buildsOn`, the `relation` to state, the `finished` documents, and what it `mustNotBring` |

A file whose `reviewed` is not true is a draft: its gates are printed as
`draft`, decide nothing, and the report says so.

Names are matched literally (case, punctuation and plural-free spelling aside),
so the inventory's aliases carry every spelling a page might use. Two pages on
one idea under names the key does not list are not found here: that is the
judge's work.

An offline rig (CLAUDE.md §3.1), reachable from no route and no
`run_backfill.sh` command.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..storage.base import memory_slug, parse_wiki_links

KEY_FORMAT = "memory-eval-key/1"
REPORT_FORMAT = "memory-eval-report/1"
#: The page model: every page is one of these kinds, and every citation one of these claim types.
PAGE_KINDS = ("source", "concept", "domain")
CLAIM_TYPES = ("author-claim", "external", "reader-note", "derived")
#: Fields of the learning model, which the page model has no place for.
RETIRED_FIELDS = ("level", "observations")
#: A page of one of these kinds is one idea's page, and so can duplicate another.
#: A source page is its document and a domain page is its domain: neither can.
STRUCTURAL_KINDS = ("source", "domain")
#: Body lengths in characters: what the model is asked for, what is accepted,
#: and the schema wall. A kind without a row has no limit of its own.
LIMITS: dict[str, dict[str, int]] = {
    "concept": {"target": 8_000, "accept": 12_000, "wall": 16_000},
    "domain": {"target": 6_000, "accept": 9_000, "wall": 12_000},
}
CITATION_RETENTION_FLOOR = 0.98
NOTHING_PRECISION_FLOOR = 0.90
#: What each claim type has to name. A `derived` claim is Delphi's own
#: calculation or reading and names no source of its own.
REQUIRED_LOCATOR = {"author-claim": "paperId", "external": "evidenceId", "reader-note": "noteId"}
EVENT_TYPES = ("import", "note-add", "note-edit", "note-delete", "chat", "small-talk", "session-end")
CONCEPT_RELATIONS = ("depends-on",)
SOURCE_RELATIONS = ("builds-on", "competes-with", "corrects", "conflicts-with")
SECTIONS = ("documents", "concepts", "mustNotSplit", "claims", "connections", "events", "associations")
MARKER = re.compile(r"\[E(\d+)\]")
_BLANK = re.compile(r"\n[ \t]*\n")
_NOT_WORD = re.compile(r"[\W_]+", re.UNICODE)

EXAMPLE_KEY: dict[str, Any] = {
    "format": KEY_FORMAT,
    "reviewed": False,
    "reviewedBy": None,
    "note": "An example of every section. A real key is reviewed by a person before it gates anything.",
    "documents": [
        {"key": "rope", "id": "774e17fe5472", "title": "Rotary position embedding", "account": "reader", "project": "Architectures"},
        {"key": "variants", "id": "0123456789ab", "title": "A survey of rotary variants"},
    ],
    "concepts": [
        {"id": "position-encoding", "title": "Position encoding", "aliases": ["positional encoding", "position embeddings"],
         "domain": "architectures", "documents": ["rope", "variants"]},
        {"id": "attention", "title": "Self-attention", "aliases": [], "documents": ["rope"]},
    ],
    "mustNotSplit": [
        {"first": "position-encoding", "second": ["Rotary position embedding", "RoPE", "RoPE variants"],
         "reason": "Rotary variants are content of the position-encoding page, not a page of their own."},
    ],
    "claims": [
        {"id": "g1", "concept": "position-encoding",
         "text": "RoPE rotates each pair of dimensions by an angle proportional to the token's position.",
         "numbers": [{"value": "10000", "unit": "base of the frequency schedule", "condition": "the default"}],
         "locator": {"document": "rope", "section": "rotary-position-embedding"}},
    ],
    "connections": [
        {"domain": "architectures",
         "concepts": [{"from": "position-encoding", "to": "attention", "relation": "depends-on"}],
         "sources": [{"from": "variants", "to": "rope", "relation": "builds-on", "evidence": "It extends the rotation to two axes."}]},
    ],
    "events": [
        {"id": "e1", "type": "import", "document": "rope",
         "expect": [{"action": "create", "concept": "position-encoding"}]},
        {"id": "e2", "type": "chat", "document": "rope", "text": "How do the rotary variants differ?",
         "expect": [{"action": "edit", "concept": "position-encoding", "mayChange": ["## Variants"], "supersedes": []}]},
        {"id": "e3", "type": "small-talk", "text": "Thanks, that helps.", "expect": []},
    ],
    "associations": [
        {"question": "c1", "buildsOn": ["position-encoding"], "relation": "The open paper applies the same rotation per axis.",
         "finished": ["rope"], "mustNotBring": ["attention"]},
    ],
}


# --- names and text ----------------------------------------------------------


def name_key(value: Any) -> str:
    """One spelling for a name: case, accents' compatibility forms, punctuation and a plural `s` aside."""
    words = _NOT_WORD.sub(" ", unicodedata.normalize("NFKC", str(value or "")).casefold()).split()
    return " ".join(word[:-1] if len(word) > 3 and word.endswith("s") and not word.endswith("ss") else word for word in words)


def page_names(page: dict[str, Any]) -> set[str]:
    return {key for key in map(name_key, (page.get("title"), page.get("slug"), *(page.get("aliases") or ()))) if key}


def blocks(body: str) -> list[str]:
    """A body as the paragraphs, headings, tables and lists that blank lines separate."""
    return [block.strip() for block in _BLANK.split(body or "") if block.strip()]


# --- keys --------------------------------------------------------------------


def validate_key(key: Any, *, source: str = "key") -> list[str]:
    """Everything malformed in one key (or several, merged), as sentences. Empty means usable."""
    if not isinstance(key, dict):
        return [f"{source}: a key file is a JSON object"]
    problems: list[str] = []

    def bad(where: str, what: str) -> None:
        problems.append(f"{source}: {where}: {what}")

    if key.get("format") != KEY_FORMAT:
        bad("format", f"must be \"{KEY_FORMAT}\"")
    if not isinstance(key.get("reviewed"), bool):
        bad("reviewed", "must be true or false; a draft says false")
    elif key["reviewed"] and not key.get("reviewedBy"):
        bad("reviewedBy", "a reviewed key names who reviewed it")
    for name in set(key) - set(SECTIONS) - {"format", "reviewed", "reviewedBy", "reviewedAt", "reviewedOn", "note"}:
        bad(name, "is not a section of a key")
    if not any(name in key for name in SECTIONS):
        bad("sections", f"holds none of {', '.join(SECTIONS)}")

    def rows(section: str) -> list[tuple[str, dict[str, Any]]]:
        value = key.get(section, [])
        if not isinstance(value, list):
            bad(section, "must be a list")
            return []
        found = []
        for index, row in enumerate(value):
            if isinstance(row, dict):
                found.append((f"{section}[{row.get('id') or row.get('key') or index}]", row))
            else:
                bad(f"{section}[{index}]", "must be an object")
        return found

    def text(where: str, row: dict[str, Any], name: str, *, optional: bool = False) -> bool:
        value = row.get(name)
        if value is None and optional:
            return True
        if not isinstance(value, str) or not value.strip():
            bad(where, f"`{name}` must be a non-empty string")
            return False
        return True

    def names(where: str, row: dict[str, Any], name: str, known: set[str], what: str, *, required: bool = False) -> None:
        value = row.get(name, [])
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            bad(where, f"`{name}` must be a list of {what} names")
            return
        if required and not value:
            bad(where, f"`{name}` must name at least one {what}")
        for item in value:
            if item not in known:
                bad(where, f"`{name}` names {item!r}, which is not a {what} in this key")

    def unique(section: str, found: list[tuple[str, dict[str, Any]]], name: str) -> set[str]:
        seen: Counter[str] = Counter(row[name] for _, row in found if isinstance(row.get(name), str))
        for value, count in seen.items():
            if count > 1:
                bad(section, f"`{name}` {value!r} is used {count} times")
        return set(seen)

    documents = rows("documents")
    for where, row in documents:
        text(where, row, "key")
        text(where, row, "id")
    document_keys = unique("documents", documents, "key")
    unique("documents", documents, "id")

    concepts = rows("concepts")
    claimed: dict[str, str] = {}
    for where, row in concepts:
        text(where, row, "id")
        text(where, row, "title")
        if not isinstance(row.get("aliases", []), list) or not all(isinstance(alias, str) for alias in row.get("aliases", [])):
            bad(where, "`aliases` must be a list of strings")
            continue
        names(where, row, "documents", document_keys, "document")
        for spelling in {name_key(row.get("title")), *map(name_key, row.get("aliases", []))} - {""}:
            if claimed.setdefault(spelling, where) != where:
                bad(where, f"the name {spelling!r} also belongs to {claimed[spelling]}: one name, one concept")
    concept_ids = unique("concepts", concepts, "id")

    for where, row in rows("mustNotSplit"):
        for side in ("first", "second"):
            value = row.get(side)
            if isinstance(value, str):
                if value not in concept_ids:
                    bad(where, f"`{side}` names {value!r}, which is not a concept in this key")
            elif not (isinstance(value, list) and value and all(isinstance(item, str) and item.strip() for item in value)):
                bad(where, f"`{side}` must be a concept id or a non-empty list of names")
        text(where, row, "reason")

    claims = rows("claims")
    for where, row in claims:
        text(where, row, "id")
        text(where, row, "text")
        if row.get("concept") not in concept_ids:
            bad(where, f"`concept` names {row.get('concept')!r}, which is not a concept in this key")
        numbers = row.get("numbers", [])
        if not isinstance(numbers, list):
            bad(where, "`numbers` must be a list")
            numbers = []
        for index, number in enumerate(numbers):
            if not isinstance(number, dict) or not isinstance(number.get("value"), str) or not number["value"].strip():
                bad(where, f"numbers[{index}]: `value` must be the number as the source prints it, as a string")
            elif not isinstance(number.get("unit"), str) or not number["unit"].strip():
                bad(where, f"numbers[{index}]: `unit` must say what {number['value']} counts")
        locator = row.get("locator")
        if not isinstance(locator, dict) or locator.get("document") not in document_keys:
            bad(where, "`locator.document` must name a document in this key")
        elif not (isinstance(locator.get("page"), int) and locator["page"] > 0) and not (
            isinstance(locator.get("section"), str) and locator["section"].strip()
        ):
            bad(where, "`locator` needs a `page` number or a `section`")
    claim_ids = unique("claims", claims, "id")

    for where, row in rows("connections"):
        text(where, row, "domain")
        for part, known, relations, what in (
            ("concepts", concept_ids, CONCEPT_RELATIONS, "concept"),
            ("sources", document_keys, SOURCE_RELATIONS, "document"),
        ):
            edges = row.get(part, [])
            if not isinstance(edges, list):
                bad(where, f"`{part}` must be a list")
                continue
            for index, edge in enumerate(edges):
                at = f"{where}.{part}[{index}]"
                if not isinstance(edge, dict):
                    bad(at, "must be an object")
                    continue
                for end in ("from", "to"):
                    if edge.get(end) not in known:
                        bad(at, f"`{end}` names {edge.get(end)!r}, which is not a {what} in this key")
                if edge.get("from") is not None and edge.get("from") == edge.get("to"):
                    bad(at, "relates a thing to itself")
                if edge.get("relation") not in relations:
                    bad(at, f"`relation` must be one of {', '.join(relations)}")

    events = rows("events")
    for where, row in events:
        text(where, row, "id")
        if row.get("type") not in EVENT_TYPES:
            bad(where, f"`type` must be one of {', '.join(EVENT_TYPES)}")
        if row.get("document") is not None and row["document"] not in document_keys:
            bad(where, f"`document` names {row['document']!r}, which is not a document in this key")
        if row.get("type") in ("import", "note-add", "note-edit", "note-delete") and row.get("document") is None:
            bad(where, f"a {row['type']} event names its `document`")
        expected = row.get("expect")
        if not isinstance(expected, list):
            bad(where, "`expect` must be a list; an empty list means nothing is filed")
            continue
        for index, expectation in enumerate(expected):
            at = f"{where}.expect[{index}]"
            if not isinstance(expectation, dict) or expectation.get("action") not in ("create", "edit"):
                bad(at, "`action` must be \"create\" or \"edit\"")
                continue
            if expectation.get("concept") not in concept_ids:
                bad(at, f"`concept` names {expectation.get('concept')!r}, which is not a concept in this key")
            fragments = expectation.get("mayChange", [])
            if not isinstance(fragments, list) or not all(isinstance(item, str) and item for item in fragments):
                bad(at, "`mayChange` must be a list of text fragments")
            elif fragments and expectation["action"] == "create":
                bad(at, "`mayChange` belongs to an edit: a created page has no earlier text")
            names(at, expectation, "supersedes", claim_ids, "claim")
    unique("events", events, "id")

    associations = rows("associations")
    for where, row in associations:
        text(where, row, "question")
        names(where, row, "buildsOn", concept_ids, "concept")
        names(where, row, "mustNotBring", concept_ids, "concept")
        names(where, row, "finished", document_keys, "document")
        if row.get("buildsOn"):
            text(where, row, "relation")
        if set(row.get("buildsOn") or ()) & set(row.get("mustNotBring") or ()):
            bad(where, "the same concept is in `buildsOn` and `mustNotBring`")
    unique("associations", associations, "question")
    return problems


def load_keys(paths: list[str | Path]) -> tuple[dict[str, Any], list[str]]:
    """
    Several key files read as one key, with everything wrong in them.

    Each file is checked for its own shape, and the merged key for references
    between files: an events file may name concepts an inventory file defines.
    The merged key is reviewed only if every file is.
    """
    merged: dict[str, Any] = {"format": KEY_FORMAT, "reviewed": bool(paths), "reviewedBy": None}
    problems: list[str] = []
    reviewers: list[str] = []
    said: set[str] = set()
    for path in map(Path, paths):
        try:
            key = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            problems.append(f"{path.name}: cannot be read as JSON ({error})")
            continue
        if not isinstance(key, dict):
            problems.append(f"{path.name}: a key file is a JSON object")
            continue
        # A name this file does not define may be another file's: that is settled on the merged key.
        own = [problem for problem in validate_key(key, source=path.name) if "in this key" not in problem]
        problems.extend(own)
        said.update(problem.split(": ", 1)[1] for problem in own)
        merged["reviewed"] = merged["reviewed"] and key.get("reviewed") is True
        if key.get("reviewedBy"):
            reviewers.append(str(key["reviewedBy"]))
        for section in SECTIONS:
            if isinstance(key.get(section), list):
                rows = merged.setdefault(section, [])
                rows.extend(row for row in key[section] if row not in rows)
    merged["reviewedBy"] = ", ".join(sorted(set(reviewers))) or None
    if any(section in merged for section in SECTIONS):
        together = Path(paths[0]).name if len(paths) == 1 else "together"
        whole = validate_key({**merged, "reviewedBy": merged["reviewedBy"] or "-"}, source=together)
        problems.extend(problem for problem in whole if problem.split(": ", 1)[1] not in said)
    return merged, sorted(set(problems))


# --- a candidate -------------------------------------------------------------


#: An account's Memory directory, newest name first: the local store's format 5
#: (`storage/local_format.py`) renamed "knowledge" to "memory". A candidate is a
#: frozen archive and is never migrated, so it is read under whichever name it holds.
MEMORY_DIRECTORIES = ("memory", "knowledge")


def memory_directory(home: Path) -> Path | None:
    """
    An account's Memory directory: `memory/`, or the `knowledge/` a store before
    format 5 kept; None when neither. An account holding both is refused, as the
    store refuses it (`local_format._split`): scoring one would score half a library.
    """
    found = [home / name for name in MEMORY_DIRECTORIES if (home / name).is_dir()]
    if len(found) > 1:
        raise SystemExit(f"{home} holds both memory/ and knowledge/: a release before format 5 wrote to it "
                         "after the rename. Move the one you do not want aside, then read it again.")
    return found[0] if found else None


@dataclass
class Candidate:
    root: Path
    user: str
    #: The account's Memory directory, as `memory_directory` found it.
    memory: Path
    pages: list[dict[str, Any]]
    documents: dict[str, dict[str, Any]]
    notes: set[str]
    evidence: set[str]
    #: Files in `pages/` that are not a page: unreadable, or named for another
    #: slug, as the " 2.json" copies a synced folder leaves are.
    strays: list[str] = field(default_factory=list)
    #: Each captured outside source by id: its record, with the captured
    #: sections read from the candidate's object store (`[]` when they are gone).
    captures: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def by_slug(self) -> dict[str, dict[str, Any]]:
        return {page["slug"]: page for page in self.pages}


def _json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def load_candidate(path: str | Path, user: str | None = None) -> Candidate:
    """Read a candidate from disk. `path` holds `users/`, or is one account's own directory."""
    root = Path(path)
    own = memory_directory(root)
    if own and not (root / "users").is_dir():
        home, user, memory = root, user or root.name, own
    else:
        # Each account by its own layout: a data root may hold one written before format 5 beside one written after.
        users = root / "users"
        layouts = {entry.name: found for entry in sorted(users.iterdir()) if (found := memory_directory(entry))} if users.is_dir() else {}
        accounts = list(layouts)
        if not accounts:
            raise SystemExit(f"{root}: no account with a Memory directory. A candidate holds users/<user>/memory/pages/, "
                             "or users/<user>/knowledge/pages/ when a store before format 5 wrote it.")
        if user is None and len(accounts) > 1:
            raise SystemExit(f"{root}: holds {', '.join(accounts)}. Say which with --user.")
        user = user or accounts[0]
        if user not in accounts:
            raise SystemExit(f"{root}: no account {user!r}; it holds {', '.join(accounts)}.")
        home, memory = root / "users" / user, layouts[user]
    pages: list[dict[str, Any]] = []
    strays: list[str] = []
    directory = memory / "pages"
    for entry in sorted(directory.iterdir()) if directory.is_dir() else ():
        if entry.suffix != ".json":
            continue
        page = _json(entry, None)
        # The store's own rule: a page is named for its slug, and a file that disagrees is not one.
        if isinstance(page, dict) and page.get("slug") == entry.stem:
            pages.append(page)
        else:
            strays.append(entry.name)
    documents: dict[str, dict[str, Any]] = {}
    notes: set[str] = set()
    for meta in sorted((home / "projects").glob("*/meta.json")):
        project = _json(meta, {})
        for paper in project.get("papers") or ():
            documents[paper["id"]] = {"id": paper["id"], "title": paper.get("title"), "pages": paper.get("pages"),
                                      "web": not str(paper.get("filename") or "").lower().endswith(".pdf"),
                                      "projectId": project.get("id") or meta.parent.name}
        for held in sorted((meta.parent / "notes").glob("*.json")):
            notes.update(str(note["id"]) for note in _json(held, []) if isinstance(note, dict) and note.get("id"))
    records = [record for record in _json(memory / "evidence.json", []) if isinstance(record, dict) and record.get("id")]
    evidence = {str(record["id"]) for record in records}
    # A capture's text is kept beside its record, as the local object store
    # lays out `external_evidence_key`; read as a file, like everything here.
    def sections(record: dict[str, Any]) -> list[dict[str, Any]]:
        held = _json(memory / "evidence" / f"{record['id']}.json", {})
        return list(held.get("sections") or []) if isinstance(held, dict) else []

    captures = {str(record["id"]): {**record, "sections": sections(record)} for record in records}
    return Candidate(root=root, user=user, memory=memory, pages=pages, documents=documents, notes=notes, evidence=evidence,
                     strays=strays, captures=captures)


# --- metrics that need no key --------------------------------------------------


def retired(candidate: Candidate) -> dict[str, Any]:
    """
    What a candidate holds that the page model has no place for.

    `kinds`: pages of a kind that is not one of `PAGE_KINDS`, by that kind.
    `claimTypes`: pages with a citation whose claim type is not one of
    `CLAIM_TYPES`, by that type. `fields`: pages still carrying the learning
    model's fields. `count` is how many pages any of the three names.
    """
    kinds: dict[str, list[str]] = {}
    claim_types: dict[str, list[str]] = {}
    for page in candidate.pages:
        if page.get("kind") not in PAGE_KINDS:
            kinds.setdefault(str(page.get("kind")), []).append(page["slug"])
        for claim_type in {str(citation.get("claimType")) for citation in page.get("citations") or ()} - set(CLAIM_TYPES):
            claim_types.setdefault(claim_type, []).append(page["slug"])
    fields = sorted(page["slug"] for page in candidate.pages if any(page.get(name) for name in RETIRED_FIELDS))
    named = {slug for slugs in (*kinds.values(), *claim_types.values(), fields) for slug in slugs}
    return {"kinds": {kind: sorted(slugs) for kind, slugs in sorted(kinds.items())},
            "claimTypes": {name: sorted(slugs) for name, slugs in sorted(claim_types.items())},
            "fields": fields, "count": len(named)}


def unresolved_links(candidate: Candidate) -> list[dict[str, str]]:
    """Every `[[slug]]` in a body with no page behind it."""
    slugs = set(candidate.by_slug)
    return [{"page": page["slug"], "target": target}
            for page in candidate.pages for target in parse_wiki_links(page.get("body") or "") if target not in slugs]


def unresolved_citations(candidate: Candidate) -> dict[str, list[dict[str, Any]]]:
    """
    Citations that do not lead anywhere in the candidate, by what is wrong:

    - `unresolved`: names a document, note or evidence record the candidate does not hold;
    - `unlocated`: its claim type needs a locator it does not carry;
    - `pageOutOfRange`: names a page past the end of its document;
    - `markers`: a body marker `[E#]` with no citation of that number.

    Whether the cited passage supports the sentence is the judge's question
    (`supported_claim_rate`); this is only whether there is a passage to open.
    """
    found: dict[str, list[dict[str, Any]]] = {"unresolved": [], "unlocated": [], "pageOutOfRange": [], "markers": []}
    stores = (("paperId", candidate.documents), ("noteId", candidate.notes), ("evidenceId", candidate.evidence))
    for page in candidate.pages:
        numbers = set()
        for citation in page.get("citations") or ():
            numbers.add(citation.get("id"))
            at = {"page": page["slug"], "citation": citation.get("id"), "claimType": citation.get("claimType")}
            for name, store in stores:
                if citation.get(name) and str(citation[name]) not in store:
                    found["unresolved"].append({**at, name: citation[name]})
            needed = REQUIRED_LOCATOR.get(str(citation.get("claimType")))
            if needed and not citation.get(needed):
                found["unlocated"].append({**at, "needs": needed})
            held = candidate.documents.get(str(citation.get("paperId")))
            if held and isinstance(citation.get("page"), int) and isinstance(held.get("pages"), int) and not held["web"]:
                if not 1 <= citation["page"] <= held["pages"]:
                    found["pageOutOfRange"].append({**at, "cites": citation["page"], "documentPages": held["pages"]})
        for number in sorted({int(value) for value in MARKER.findall(page.get("body") or "")} - numbers):
            found["markers"].append({"page": page["slug"], "marker": f"[E{number}]"})
    return found


def outside_passages(candidate: Candidate) -> dict[str, Any]:
    """
    Whether every `external` citation opens a passage containing its quote (§13.4).

    A citation names a capture and a section. It opens what it should when the
    capture's text is there, the capture holds a finding at that section, and
    that finding's quote is found in the section as captured, by the same
    comparison capture made (`harness.evidence.locate`). `cited` counts the
    citations; `failing` lists each that does not, with why.
    """
    from ..harness.evidence import locate

    cited, failing = 0, []
    for page in candidate.pages:
        for citation in page.get("citations") or ():
            if citation.get("claimType") != "external":
                continue
            cited += 1
            at = {"page": page["slug"], "citation": citation.get("id"), "evidenceId": citation.get("evidenceId"),
                  "section": citation.get("section")}
            record = candidate.captures.get(str(citation.get("evidenceId")))
            sections = [section for section in (record or {}).get("sections") or () if section.get("anchor") == citation.get("section")]
            quotes = [finding.get("quote") for finding in (record or {}).get("findings") or ()
                      if finding.get("anchor") == citation.get("section")]
            if not record or not record.get("sections"):
                failing.append({**at, "problem": "the capture's text is not in the candidate"})
            elif not sections:
                failing.append({**at, "problem": "the capture has no such section"})
            elif not any(locate(str(quote or ""), sections) for quote in quotes):
                failing.append({**at, "problem": "no quote of the capture is found in that section"})
    return {"cited": cited, "failing": failing}


def over_length(candidate: Candidate) -> list[dict[str, Any]]:
    """Pages whose body is past the length their kind is accepted at, and how far."""
    found = []
    for page in candidate.pages:
        limit = LIMITS.get(str(page.get("kind")))
        length = len(page.get("body") or "")
        if limit and length > limit["accept"]:
            found.append({"page": page["slug"], "kind": page["kind"], "length": length, "accept": limit["accept"],
                          "pastTheWall": length > limit["wall"]})
    return found


# --- metrics against the concept inventory --------------------------------------


def _spellings(key: dict[str, Any], side: Any) -> set[str]:
    concepts = {concept["id"]: concept for concept in key.get("concepts") or ()}
    if isinstance(side, str):
        concept = concepts[side]
        side = [concept["title"], *concept.get("aliases", [])]
    return {name_key(name) for name in side} - {""}


def inventory(candidate: Candidate, key: dict[str, Any]) -> dict[str, Any]:
    """
    The page set against the concept inventory.

    `duplicates`: two or more pages whose title, alias or slug is a name of one
    inventory concept. `splits`: a must-not-split pair with a page on each
    side. `missing`: a concept that must exist and has no page. Source and
    domain pages are not counted: neither is one idea's page.
    """
    pages = [page for page in candidate.pages if page.get("kind") not in STRUCTURAL_KINDS]
    holders: dict[str, list[str]] = {}
    for page in pages:
        for name in page_names(page):
            holders.setdefault(name, []).append(page["slug"])

    def held(names: set[str]) -> list[str]:
        return sorted({slug for name in names for slug in holders.get(name, ())})

    matched = {concept["id"]: held(_spellings(key, concept["id"])) for concept in key.get("concepts") or ()}
    splits = []
    for pair in key.get("mustNotSplit") or ():
        first, second = held(_spellings(key, pair["first"])), held(_spellings(key, pair["second"]))
        # One page answering to both names is the wanted outcome, not a split.
        if first and second and set(first) != set(second):
            splits.append({"first": first, "second": second, "reason": pair.get("reason")})
    return {
        "concepts": len(matched),
        "present": sorted(concept for concept, slugs in matched.items() if slugs),
        "missing": sorted(concept for concept, slugs in matched.items() if not slugs),
        "duplicates": [{"concept": concept, "pages": slugs} for concept, slugs in sorted(matched.items()) if len(slugs) > 1],
        "splits": splits,
        "pages": matched,
    }


def claim_numbers(candidate: Candidate, key: dict[str, Any], matched: dict[str, list[str]]) -> dict[str, Any]:
    """
    For each gold claim that carries numbers: are they printed on its concept's page?

    A proxy, and reported as one. A number on the page says nothing about
    whether the sentence around it is right (`gold_claim_recall`, which needs
    the judge, does), but a number absent from the page is a claim that cannot
    have been recalled, and across an edit that is retention measured exactly.
    """
    rows = []
    for claim in key.get("claims") or ():
        values = [number["value"] for number in claim.get("numbers") or ()]
        if not values:
            continue
        text = "\n".join(candidate.by_slug[slug].get("body") or "" for slug in matched.get(claim["concept"], ()))
        missing = [value for value in values if not re.search(rf"(?<![\d.]){re.escape(value)}(?!\d|\.\d)", text)]
        rows.append({"claim": claim["id"], "concept": claim["concept"], "numbers": len(values), "missing": missing})
    return {"claims": len(rows), "allPresent": sum(1 for row in rows if not row["missing"]),
            "absent": [row for row in rows if row["missing"]]}


# --- a scripted edit -----------------------------------------------------------


def _identity(citation: dict[str, Any]) -> tuple[Any, ...]:
    # Not the number: an edit renumbers, and the same passage under a new number is retained.
    return tuple(citation.get(name) for name in ("claimType", "paperId", "page", "section", "noteId", "evidenceId"))


def _cited(page: dict[str, Any], within: list[str] | None = None) -> set[tuple[Any, ...]]:
    """The citations a body actually uses, optionally only those used in the given blocks."""
    numbers = {int(value) for text in (within if within is not None else [page.get("body") or ""]) for value in MARKER.findall(text)}
    return {_identity(citation) for citation in page.get("citations") or () if citation.get("id") in numbers}


def edit_safety(before: dict[str, Any], after: dict[str, Any], may_change: list[str] | tuple[str, ...] = ()) -> dict[str, Any]:
    """
    What one edit kept of the revision before it.

    The earlier body is read as blocks. A block containing one of the
    `may_change` fragments is the script's to rewrite; every other block is
    untouched text and must still be in the later body word for word. A
    citation the earlier body used outside the script's blocks must still be
    used by the later body (`citationRetention`, of which 98% is asked across
    all edits). With no `may_change`, the edit is an addition and the whole
    earlier body is untouched text.
    """
    earlier = blocks(before.get("body") or "")
    scripted = [block for block in earlier if any(fragment in block for fragment in may_change)]
    untouched = [block for block in earlier if block not in scripted]
    later = after.get("body") or ""
    later_blocks = set(blocks(later))
    missing = [block for block in untouched if block not in later_blocks and block not in later]
    owed = _cited(before, untouched)
    kept = owed & _cited(after)
    return {
        "page": before.get("slug"),
        "revisionBefore": before.get("revision"), "revisionAfter": after.get("revision"),
        "blocksBefore": len(earlier), "untouched": len(untouched),
        "untouchedMissing": [block[:160] for block in missing],
        "untouchedKept": not missing,
        "removedShare": round(len(missing) / len(earlier), 4) if earlier else 0.0,
        "citationsOwed": len(owed), "citationsRetained": len(kept),
        "citationsLost": [dict(zip(("claimType", "paperId", "page", "section", "noteId", "evidenceId"), identity))
                          for identity in sorted(owed - kept, key=repr)],
        "citationRetention": round(len(kept) / len(owed), 4) if owed else None,
    }


def page_changes(before: Candidate, after: Candidate) -> dict[str, list[str]]:
    """Which idea pages one event created, edited and deleted. Source and domain pages are derived and not counted."""
    def ideas(candidate: Candidate) -> dict[str, dict[str, Any]]:
        return {slug: page for slug, page in candidate.by_slug.items() if page.get("kind") not in STRUCTURAL_KINDS}

    earlier, later = ideas(before), ideas(after)
    written = ("title", "summary", "body", "citations", "aliases", "kind")
    return {
        "created": sorted(set(later) - set(earlier)),
        "deleted": sorted(set(earlier) - set(later)),
        "edited": sorted(slug for slug in set(earlier) & set(later)
                         if any(earlier[slug].get(name) != later[slug].get(name) for name in written)),
    }


def score_events(key: dict[str, Any], snapshots: str | Path, user: str | None = None) -> dict[str, Any]:
    """
    The scripted sequence against the event expectations.

    `snapshots` holds one candidate per moment: `start/`, then a directory
    named for each event's id, taken after that event's work drained. An
    event's "before" is the snapshot before it in the key's order. Events with
    no snapshot are listed and not scored.

    - create-vs-edit accuracy: of the expectations, how many came out as the
      action the key names (an expected edit that became a new page is wrong).
    - nothing-to-file precision: of the events after which nothing was filed,
      how many the key says should file nothing. Recall is reported beside it
      (of the events the key says file nothing, how many filed nothing), because
      the plan's gate can be read either way.
    - for each expected edit, `edit_safety`.
    """
    root = Path(snapshots)
    concepts = {concept["id"]: _spellings(key, concept["id"]) for concept in key.get("concepts") or ()}
    rows: list[dict[str, Any]] = []
    unscored: list[str] = []
    previous = load_candidate(root / "start", user) if (root / "start").is_dir() else None
    for event in key.get("events") or ():
        if previous is None or not (root / event["id"]).is_dir():
            unscored.append(event["id"])
            continue
        current = load_candidate(root / event["id"], user)
        changes = page_changes(previous, current)
        row: dict[str, Any] = {"event": event["id"], "type": event.get("type"), **changes, "expectations": [], "edits": []}
        accounted: set[str] = set()
        for expectation in event["expect"]:
            names = concepts[expectation["concept"]]
            existing = [slug for slug, page in previous.by_slug.items() if page_names(page) & names and page.get("kind") not in STRUCTURAL_KINDS]
            made = [slug for slug in changes["created"] if page_names(current.by_slug[slug]) & names]
            revised = [slug for slug in changes["edited"] if slug in existing]
            observed = "create" if made else "edit" if revised else "nothing"
            accounted.update(made, revised)
            row["expectations"].append({"concept": expectation["concept"], "expected": expectation["action"],
                                        "observed": observed, "ok": observed == expectation["action"]})
            if expectation["action"] == "edit":
                for slug in revised:
                    row["edits"].append(edit_safety(previous.by_slug[slug], current.by_slug[slug], expectation.get("mayChange") or ()))
        row["unexpected"] = sorted(set(changes["created"] + changes["edited"] + changes["deleted"]) - accounted)
        row["filedNothing"] = not (changes["created"] or changes["edited"] or changes["deleted"])
        row["expectsNothing"] = not event["expect"]
        rows.append(row)
        previous = current
    expectations = [expectation for row in rows for expectation in row["expectations"]]
    edits = [edit for row in rows for edit in row["edits"]]
    silent = [row for row in rows if row["filedNothing"]]
    quiet = [row for row in rows if row["expectsNothing"]]
    owed = sum(edit["citationsOwed"] for edit in edits)

    def share(part: int, whole: int) -> float | None:
        return round(part / whole, 4) if whole else None

    return {
        "events": len(rows), "unscored": unscored, "rows": rows,
        "createVsEditAccuracy": share(sum(1 for expectation in expectations if expectation["ok"]), len(expectations)),
        "nothingToFilePrecision": share(sum(1 for row in silent if row["expectsNothing"]), len(silent)),
        "nothingToFileRecall": share(sum(1 for row in quiet if row["filedNothing"]), len(quiet)),
        "edits": len(edits),
        "editsKeepingUntouchedText": sum(1 for edit in edits if edit["untouchedKept"]),
        "citationRetention": share(sum(edit["citationsRetained"] for edit in edits), owed),
    }


# --- the report ---------------------------------------------------------------


def score_candidate(
    candidate: Candidate, key: dict[str, Any] | None = None, *, events: dict[str, Any] | None = None, arm: str = "", gated: bool = True,
) -> dict[str, Any]:
    """
    Every deterministic metric for one candidate, with the release gates they decide.

    This is also the quality section the rebuild report is to carry: the dict
    is plain JSON. A gate is `pass`, `FAIL`, or `draft` when it rests on a key
    nobody has reviewed; a reference arm (`gated=False`) is measured and
    decides nothing.
    """
    key = key or {}
    reviewed = key.get("reviewed") is True
    gone, links, citations, long = retired(candidate), unresolved_links(candidate), unresolved_citations(candidate), over_length(candidate)
    broken = sum(len(rows) for name, rows in citations.items() if name != "pageOutOfRange")
    summary: dict[str, Any] = {
        "format": REPORT_FORMAT, "candidate": str(candidate.root), "user": candidate.user, "arm": arm, "gated": gated,
        "keysReviewed": reviewed if key.get("concepts") or key.get("events") else None,
        "pages": {"total": len(candidate.pages), "byKind": dict(sorted(Counter(str(page.get("kind")) for page in candidate.pages).items())),
                  "strayFiles": candidate.strays},
        "documents": len(candidate.documents),
        "metrics": {
            "retired": gone, "unresolvedLinks": links, "citations": citations, "overLength": long,
            "citationsTotal": sum(len(page.get("citations") or ()) for page in candidate.pages),
        },
        "gates": [],
        "needsJudge": [{"metric": name, "status": "measured by memory_judge", "what": what}
                       for name, what in JUDGE_METRICS.items()],
    }

    def gate(label: str, ok: bool, detail: str, *, keyed: bool = False) -> None:
        status = "measured" if not gated else "draft" if keyed and not reviewed else "pass" if ok else "FAIL"
        summary["gates"].append({"label": label, "status": status, "ok": ok, "detail": detail})

    gate("no retired kind, claim type or level", not gone["count"], "; ".join(part for part in (
        ", ".join(f"{len(slugs)} {kind}" for kind, slugs in gone["kinds"].items()),
        ", ".join(f"{len(slugs)} citing as {name}" for name, slugs in gone["claimTypes"].items()),
        f"{len(gone['fields'])} with level or observations" if gone["fields"] else "",
    ) if part) or "none")
    gate("no unresolved link", not links, f"{len(links)} in {len({row['page'] for row in links})} page(s)" if links else "none")
    gate("every citation resolves", not broken,
         ", ".join(f"{len(rows)} {name}" for name, rows in citations.items() if rows and name != "pageOutOfRange") or "all do")
    outside = outside_passages(candidate)
    if outside["cited"]:
        # Measured only where there is something to open: a candidate that cites no capture has no such gate.
        summary["metrics"]["outsidePassages"] = outside
        gate("every external citation opens a passage containing its quote", not outside["failing"],
             f"{len(outside['failing'])} of {outside['cited']} do not" if outside["failing"] else f"all {outside['cited']} do")
    if key.get("concepts"):
        held = inventory(candidate, key)
        summary["metrics"]["inventory"] = held
        violations = len(held["duplicates"]) + len(held["splits"])
        gate("duplicate violations: zero", not violations,
             f"{len(held['duplicates'])} concept(s) on two pages, {len(held['splits'])} split pair(s)", keyed=True)
        if key.get("claims"):
            summary["metrics"]["claimNumbers"] = claim_numbers(candidate, key, held["pages"])
    if events is not None:
        summary["metrics"]["events"] = events
        if events["edits"]:
            gate("untouched text survives every scripted edit", events["editsKeepingUntouchedText"] == events["edits"],
                 f"{events['editsKeepingUntouchedText']} of {events['edits']} edits", keyed=True)
        if events["citationRetention"] is not None:
            gate(f"citation retention at least {CITATION_RETENTION_FLOOR:.0%}", events["citationRetention"] >= CITATION_RETENTION_FLOOR,
                 f"{events['citationRetention']:.1%}", keyed=True)
        if events["nothingToFilePrecision"] is not None:
            gate(f"nothing-to-file precision at least {NOTHING_PRECISION_FLOOR:.0%}", events["nothingToFilePrecision"] >= NOTHING_PRECISION_FLOOR,
                 f"{events['nothingToFilePrecision']:.0%}", keyed=True)
    summary["failed"] = any(row["status"] == "FAIL" for row in summary["gates"])
    return summary


def table(summary: dict[str, Any]) -> str:
    """The short table `report` prints."""
    pages, metrics = summary["pages"], summary["metrics"]
    kinds = ", ".join(f"{count} {kind}" for kind, count in pages["byKind"].items())
    arm = f"arm {summary['arm']}, " if summary["arm"] else ""
    lines = [f"Memory candidate {summary['candidate']} ({arm}account {summary['user']})",
             f"  {pages['total']} pages ({kinds}) over {summary['documents']} documents, {metrics['citationsTotal']} citations"]
    if pages["strayFiles"]:
        lines.append(f"  {len(pages['strayFiles'])} file(s) in pages/ are not pages: {', '.join(pages['strayFiles'][:5])}")
    if summary["keysReviewed"] is False:
        lines.append("  DRAFT KEYS: no person has reviewed them. Gates resting on them are shown as `draft` and decide nothing.")
    if not summary["gated"]:
        lines.append("  A reference arm: measured, and gated on nothing.")
    width = max(len(row["label"]) for row in summary["gates"])
    for row in summary["gates"]:
        lines.append(f"  {row['status']:<8}  {row['label']:<{width}}  {row['detail']}")
    reported = [("pages past their accepted length", f"{len(metrics['overLength'])}"),
                ("citations past the end of their document", f"{len(metrics['citations']['pageOutOfRange'])}")]
    if "inventory" in metrics:
        held = metrics["inventory"]
        reported.append(("inventory concepts with a page", f"{len(held['present'])} of {held['concepts']}"))
    if "claimNumbers" in metrics:
        numbers = metrics["claimNumbers"]
        reported.append(("gold claims whose numbers are on the page (a proxy)", f"{numbers['allPresent']} of {numbers['claims']}"))
    if "events" in metrics:
        events = metrics["events"]
        for label, name in (("create-vs-edit accuracy", "createVsEditAccuracy"), ("nothing-to-file recall", "nothingToFileRecall")):
            if events[name] is not None:
                reported.append((label, f"{events[name]:.0%}"))
        if events["unscored"]:
            reported.append(("events with no snapshot", ", ".join(events["unscored"])))
    width = max(len(label) for label, _ in reported)
    lines.append("  reported, not gated:")
    lines.extend(f"    {label:<{width}}  {value}" for label, value in reported)
    for arm_name, arm_row in (summary.get("chat") or {}).get("arms", {}).items():
        judged = arm_row.get("judged")
        graded = f"{judged['stated']} of {judged['facts']} key facts" if judged else "not judged"
        first = f"{arm_row['firstTextMs'] / 1000:.1f}s to first text" if arm_row.get("firstTextMs") else "no timing"
        lines.append(f"  chat arm {arm_name}: {arm_row['answers']} answers, {graded}, {first}")
    lines.append(f"  needs a judge model (memory_judge): {', '.join(row['metric'] for row in summary['needsJudge'])}")
    return "\n".join(lines)


# --- the metrics that need a judge model ---------------------------------------
# Measured by `memory_judge`, which calls a model; this module calls none. They
# are named here so the report can say what it does not measure.

JUDGE_METRICS = {
    "gold-claim recall": "For each gold claim, is it present and correct on its concept's page?",
    "supported-claim rate": "Of a page's atomic claims, how many does the cited passage entail?",
    "domain rubric": "Each domain page on orientation, concept relations, sources connected, reading order, not a link list.",
    "blind pairwise preference": "Blind, per concept, the old page set against the new one, in both orders.",
    "edit safety by meaning": "Across each edit, was anything lost or changed in meaning that the edit does not account for?",
}


# --- commands -----------------------------------------------------------------


def _keys_or_exit(paths: list[str]) -> dict[str, Any]:
    key, problems = load_keys(list(paths))
    if problems:
        raise SystemExit("The keys are malformed:\n  " + "\n  ".join(problems))
    return key


def command_formats(args: argparse.Namespace) -> int:
    print(json.dumps(EXAMPLE_KEY, indent=2, ensure_ascii=False))
    return 0


def command_keys(args: argparse.Namespace) -> int:
    key, problems = load_keys(args.files)
    for problem in problems:
        print(f"  malformed  {problem}")
    counts = ", ".join(f"{len(key[section])} {section}" for section in SECTIONS if key.get(section))
    state = "reviewed by " + key["reviewedBy"] if key["reviewed"] and key["reviewedBy"] else "DRAFT, not reviewed"
    print(f"{len(args.files)} key file(s): {counts or 'no sections'}; {state}; {len(problems)} problem(s)")
    return 1 if problems else 0


def command_pages(args: argparse.Namespace) -> int:
    summary = score_candidate(load_candidate(args.candidate, args.user), arm=args.arm, gated=not args.reference)
    print(table(summary))
    return 1 if summary["failed"] else 0


def command_edit(args: argparse.Namespace) -> int:
    before, after = load_candidate(args.before, args.user).by_slug, load_candidate(args.after, args.user).by_slug
    missing = [where for where, pages in (("--before", before), ("--after", after)) if args.slug not in pages]
    if missing:
        raise SystemExit(f"No page {args.slug!r} in {' or '.join(missing)}.")
    result = edit_safety(before[args.slug], after[args.slug], args.may_change or ())
    print(json.dumps(result, indent=2, ensure_ascii=False))
    retention = result["citationRetention"]
    return 0 if result["untouchedKept"] and (retention is None or retention >= CITATION_RETENTION_FLOOR) else 1


def command_events(args: argparse.Namespace) -> int:
    key = _keys_or_exit(args.key)
    if not key.get("events"):
        raise SystemExit("None of the key files holds an `events` section.")
    result = score_events(key, args.snapshots, args.user)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


def command_report(args: argparse.Namespace) -> int:
    if args.chat and not args.questions:
        raise SystemExit("--chat needs --questions: the question file the chat rig was run with.")
    key = _keys_or_exit(args.key) if args.key else None
    events = None
    if args.snapshots:
        if not key or not key.get("events"):
            raise SystemExit("--snapshots needs a key file with an `events` section.")
        events = score_events(key, args.snapshots, args.user)
    summary = score_candidate(load_candidate(args.candidate, args.user), key, events=events, arm=args.arm, gated=not args.reference)
    if args.chat:
        from . import chat_benchmark  # the answer side; imported here so page scoring needs no HTTP client

        summary["chat"] = chat_benchmark.summarise(Path(args.chat), chat_benchmark.load_questions(args.questions))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    target = out / f"memory-eval{'-' + args.arm if args.arm else ''}.json"
    target.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(table(summary))
    print(f"  written to {target}")
    return 1 if summary["failed"] else 0


def parser() -> argparse.ArgumentParser:
    made = argparse.ArgumentParser(
        prog="python -m delphi_core.backfill.memory_eval",
        description="Score a Memory candidate's pages against reviewed answer keys. Deterministic: no command here calls a model.",
        epilog="A candidate is a directory holding users/<user>/memory/pages/, as `memory_rebuild --stage` builds one, "
               "or users/<user>/knowledge/pages/ as a store before format 5 wrote it: each account is read as it was "
               "written, and nothing here migrates or writes to a candidate. "
               "Measured by `python -m delphi_core.backfill.memory_judge`, which calls a judge model: " + ", ".join(JUDGE_METRICS) + ".",
    )
    commands = made.add_subparsers(dest="command", required=True, metavar="command")

    def add(name: str, told: str, more: str = "") -> argparse.ArgumentParser:
        return commands.add_parser(name, help=told, description=f"{told[0].upper()}{told[1:]}. {more}".strip())

    def candidate_options(command: argparse.ArgumentParser) -> None:
        command.add_argument("--user", help="the account, when the directory holds more than one")
        command.add_argument("--arm", default="", help="a name for this candidate in the output, for example old or new")
        command.add_argument("--reference", action="store_true",
                             help="measure and gate nothing: for the old arm, which is the baseline and is expected to fail")

    add("formats", "print a complete example key file, with every section",
        "The module docstring says what each section holds; this is the JSON to copy.")
    keys = add("keys", "validate key files and say what is malformed",
               "Several files are checked one by one and then together, so one file may name another's concepts.")
    keys.add_argument("files", nargs="+", metavar="KEY")
    pages = add("pages", "the checks that need no key: kinds and claim types outside the page model, unresolved [[links]], citations that lead nowhere, length")
    pages.add_argument("--candidate", required=True, metavar="DIR")
    candidate_options(pages)
    edit = add("edit", "one page before and after an edit: citation retention, and whether the untouched text is still there",
               "Exits 1 if untouched text is gone or fewer than 98% of the earlier citations are still used.")
    edit.add_argument("--before", required=True, metavar="DIR", help="the candidate as it stood before the edit")
    edit.add_argument("--after", required=True, metavar="DIR", help="the candidate after it")
    edit.add_argument("--slug", required=True)
    edit.add_argument("--user")
    edit.add_argument("--may-change", action="append", metavar="TEXT",
                      help="a fragment of a block the script expects to be rewritten; repeat for more. Without it the edit is an addition")
    events = add("events", "the scripted event sequence against the event expectations",
                 "Reads <snapshots>/start/ and <snapshots>/<event id>/, one candidate per moment.")
    events.add_argument("--key", required=True, action="append", metavar="KEY")
    events.add_argument("--snapshots", required=True, metavar="DIR")
    events.add_argument("--user")
    report = add("report", "every deterministic metric and gate for one candidate: a JSON summary and a short table",
                 "Writes <out>/memory-eval-<arm>.json. Exits 1 when a gate fails; draft keys and a --reference arm fail nothing.")
    report.add_argument("--candidate", required=True, metavar="DIR")
    report.add_argument("--out", required=True, metavar="DIR")
    report.add_argument("--key", action="append", metavar="KEY", help="a key file; repeat for more")
    report.add_argument("--snapshots", metavar="DIR", help="score the scripted events too, from these snapshots")
    report.add_argument("--chat", metavar="DIR", help="fold in the chat rig's summary from its --out directory")
    report.add_argument("--questions", metavar="PATH", help="the question file the chat rig was run with; needed with --chat")
    candidate_options(report)
    return made


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    return {"formats": command_formats, "keys": command_keys, "pages": command_pages, "edit": command_edit,
            "events": command_events, "report": command_report}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
