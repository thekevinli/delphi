"""
The metrics of a Memory candidate that need a judge model (Plan 2 §13.2).

    backend/.venv/bin/python -m delphi_core.backfill.memory_judge recall  --candidate <dir> --key k.json ... --model M --out r.json
    backend/.venv/bin/python -m delphi_core.backfill.memory_judge support --candidate <dir> --model M --out s.json [--pages a,b]
    backend/.venv/bin/python -m delphi_core.backfill.memory_judge domains --candidate <dir> --key k.json ... --model M --out d.json
    backend/.venv/bin/python -m delphi_core.backfill.memory_judge prefer  --old <dir> --new <dir> --key k.json ... --model M --out p.json
    backend/.venv/bin/python -m delphi_core.backfill.memory_judge edits   --candidate <dir> --model M --out e.json

`memory_eval` is the deterministic half and calls no model; this is the half
that does, kept apart so that one stays free. Each metric asks one strict-JSON
question per item and reads the candidate's files as `memory_eval` does,
never through `LocalStorage`.

- `recall`: for each gold claim, is it on its concept's page, and right?
- `support`: for each paragraph that cites, split into atomic claims, and is
  each one entailed by the passage it cites?
- `domains`: each domain page on the rubric (orientation, how concepts
  relate, sources connected with evidence, a reading order, not a link list),
  against the Connections key.
- `prefer`: blind pairwise preference, old page set against new, per
  inventory concept, in both orders, ties allowed.
- `edits`: across each edit in a concept page's version history, did the
  page lose or change in meaning anything the edit's note does not account
  for? Edit safety judged by meaning, which a text match cannot do
  (`5.9e23` and `5.88\\times10^{23}` are one number).

The judge is a different model from the one that wrote the pages (`--model`
names it). `--runs` repeats a metric and reports each number's spread, and
`--labels` a person's verdicts by item id, against which the judge's
agreement is reported: a metric whose judge disagrees with people gates
nothing. Every call is real money. An offline rig, reachable from no route.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

import httpx

from ..config import Settings
from ..document_index import PAGE_MARKER
from .memory_eval import MARKER, STRUCTURAL_KINDS, Candidate, blocks, inventory, load_candidate, load_keys

#: One question: (schema name, instructions, payload, JSON schema) -> the answer.
Judge = Callable[[str, str, Mapping[str, Any], Mapping[str, Any]], dict[str, Any]]
PAGE_MAX_CHARS = 24_000
PASSAGE_MAX_CHARS = 6_000
#: Retries for a transient refusal (a rate limit, an overloaded server). An
#: account out of credit is not transient and stops the run.
RETRIES = 3


class ResponsesJudge:
    """A judge over the Responses API of the configured provider: one strict-JSON request a question."""

    def __init__(self, model: str, settings: Settings | None = None, http: httpx.Client | None = None) -> None:
        self.model = model
        self.settings = settings or Settings()
        self.http = http or httpx.Client(timeout=300)
        self.calls = 0

    def __call__(self, name: str, instructions: str, payload: Mapping[str, Any], schema: Mapping[str, Any]) -> dict[str, Any]:
        body = {
            "model": self.model, "store": False, "instructions": instructions,
            "text": {"format": {"type": "json_schema", "name": name, "strict": True, "schema": schema}},
            "input": json.dumps(payload, ensure_ascii=False),
        }
        for attempt in range(RETRIES + 1):
            self.calls += 1
            response = self.http.post(
                f"{self.settings.api_base_url.rstrip('/')}/responses",
                headers={"Authorization": f"Bearer {self.settings.api_key}"}, json=body,
            )
            transient = response.status_code >= 500 or (
                response.status_code == 429 and "insufficient_quota" not in response.text
            )
            if transient and attempt < RETRIES:
                time.sleep(2 ** attempt * 5)
                continue
            response.raise_for_status()
            text = "".join(
                block.get("text") or "" for item in response.json().get("output", ())
                for block in item.get("content") or () if block.get("type") == "output_text"
            )
            return json.loads(text)
        raise AssertionError("unreachable")


def _strict(properties: Mapping[str, Any]) -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "required": list(properties), "properties": dict(properties)}


def _cut(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + "\n[cut here]"


def _home(candidate: Candidate) -> Path:
    nested = candidate.root / "users" / candidate.user
    return nested if nested.is_dir() else candidate.root


# --- passages ---------------------------------------------------------------------


class Passages:
    """
    The text a citation's locator names, read from the candidate's files.

    A PDF's page (its extracted text under `--- Page N ---` markers), a saved
    page's or a captured source's section, a note the reader wrote. None when
    there is nothing to read, which the caller reports and does not judge.
    """

    def __init__(self, candidate: Candidate) -> None:
        self.candidate = candidate
        self.home = _home(candidate)
        self._texts: dict[str, str] = {}
        self._notes: dict[str, str] | None = None

    def _paper(self, paper_id: str, ext: str) -> Path | None:
        held = self.candidate.documents.get(paper_id)
        return self.home / "projects" / str(held["projectId"]) / "papers" / f"{paper_id}.{ext}" if held else None

    @staticmethod
    def _section(sections: Sequence[Mapping[str, Any]], anchor: str) -> str | None:
        wanted = anchor.lstrip("#§").casefold()
        for section in sections:
            if str(section.get("anchor") or "").casefold() == wanted:
                return f"{section.get('title') or ''}\n\n{section.get('markdown') or ''}".strip()
        return None

    def _note(self, note_id: str) -> str | None:
        if self._notes is None:
            self._notes = {}
            for held in self.home.glob("projects/*/notes/*.json"):
                for note in json.loads(held.read_text(encoding="utf-8")) or ():
                    if isinstance(note, dict) and note.get("id"):
                        self._notes[str(note["id"])] = (
                            f"Passage the reader marked: {note.get('quotedText') or ''}\n\nWhat the reader wrote: {note.get('body') or ''}"
                        )
        return self._notes.get(note_id)

    def __call__(self, citation: Mapping[str, Any]) -> str | None:
        try:
            if citation.get("noteId"):
                return self._note(str(citation["noteId"]))
            if citation.get("evidenceId"):
                record = json.loads((self.candidate.memory / "evidence" / f"{citation['evidenceId']}.json").read_text(encoding="utf-8"))
                return self._section(record.get("sections") or (), str(citation.get("section") or ""))
            paper_id = str(citation.get("paperId") or "")
            if citation.get("section"):
                web = self._paper(paper_id, "web")
                if web and web.is_file():
                    return self._section(json.loads(web.read_text(encoding="utf-8")).get("sections") or (), str(citation["section"]))
            if isinstance(citation.get("page"), int):
                if paper_id not in self._texts:
                    path = self._paper(paper_id, "txt")
                    self._texts[paper_id] = path.read_text(encoding="utf-8") if path and path.is_file() else ""
                for found in PAGE_MARKER.finditer(self._texts[paper_id]):
                    if int(found.group("page")) == citation["page"]:
                        return found.group("text").strip()
        except (OSError, ValueError):
            return None
        return None


# --- which pages are a concept's ---------------------------------------------------------

MATCH_INSTRUCTIONS = """
You map the concepts of a reviewed inventory to the pages of a reader's
Memory that explain them. You are given each concept (its id, title and other
names) and each page (its slug, title, other names and summary). For each
concept, list the slugs of the pages whose main subject is that concept, under
whatever name; a page that only mentions it in passing is not one. A concept
may have no page, and a page may serve no concept. Use only the slugs given.
""".strip()
MATCH_SCHEMA = _strict({
    "matches": {"type": "array", "items": _strict({"concept": {"type": "string"}, "pages": {"type": "array", "items": {"type": "string"}}})},
})


def match_concepts(candidate: Candidate, key: Mapping[str, Any], *, judge: Judge) -> dict[str, list[str]]:
    """
    Each inventory concept's pages, by meaning: the literal name match and the judge's together.

    `memory_eval.inventory` finds a concept's page only under a name the key
    lists, and a page titled "Rotary position embedding" is not found for
    "position encoding". One question shows the judge every concept and every
    idea page (title, names, summary) and asks which pages are each concept's.
    A slug the judge invents is dropped. The literal matches are kept, so the
    judge can only add pages.
    """
    literal = inventory(candidate, dict(key))["pages"]
    pages = [page for page in candidate.pages if page.get("kind") not in STRUCTURAL_KINDS]
    if not pages or not key.get("concepts"):
        return literal
    payload = {
        "concepts": [{"id": concept["id"], "title": concept.get("title"), "names": concept.get("aliases") or []} for concept in key["concepts"]],
        "pages": [{"slug": page["slug"], "title": page.get("title"), "names": page.get("aliases") or [], "summary": page.get("summary") or ""} for page in pages],
    }
    answer = judge("concept_pages", MATCH_INSTRUCTIONS, payload, MATCH_SCHEMA)
    known = {page["slug"] for page in pages}
    judged = {row["concept"]: [slug for slug in row["pages"] if slug in known] for row in answer["matches"]}
    return {concept: sorted(set(slugs) | set(judged.get(concept, ()))) for concept, slugs in literal.items()}


# --- the metrics --------------------------------------------------------------------

RECALL_INSTRUCTIONS = """
You check whether a page in a reader's Memory states one fact from a reviewed
key. You are given the fact (its text, its numbers with units and conditions,
and where the source says it) and the page. A fact may bundle several details.
Answer `correct` when the page states the fact with its numbers and conditions;
a paraphrase counts, and a number written another way (5.88e23, 5.88 x 10^23,
or an exponent pair for the same ratio) is the same number. Answer `partial`
when the page states the fact's core correctly but leaves out some of its
details or conditions. Answer `wrong` only when something the page states
contradicts the fact: a different number, a condition stated differently, a
result credited to a different source, or the opposite conclusion. Leaving a
detail out is `partial`, never `wrong`. Answer `absent` when the page does not
state the fact. Quote the page sentence you relied on, or nothing when it is
absent. Be literal; do not reward length or style.
""".strip()
RECALL_SCHEMA = _strict({
    "verdict": {"type": "string", "enum": ["correct", "partial", "wrong", "absent"]},
    "quote": {"type": "string"},
    "reason": {"type": "string"},
})


def gold_claim_recall(
    candidate: Candidate, key: Mapping[str, Any], *, judge: Judge, matched: Mapping[str, list[str]] | None = None,
) -> dict[str, Any]:
    """
    Coverage: for each gold claim, is it present and correct on its concept's page?

    The judge is given the claim (text, numbers with units and conditions, its
    locator) and every page the inventory matches to the claim's concept, and
    answers correct, partial (the core stated, details left out), wrong (it
    contradicts the claim) or absent. A concept with no page is absent without
    a question. `matched` is each concept's pages (`match_concepts`); without
    it, the literal name match. Reported per claim and as recall (correct over all claims),
    with wrong counted apart: a wrong number is worse than a missing one. The
    gate is `new` above `old`. Run on a page before and after a scripted edit,
    the same question measures gold-claim retention.
    """
    matched = matched if matched is not None else inventory(candidate, dict(key))["pages"]
    rows = []
    for claim in key.get("claims") or ():
        slugs = matched.get(claim["concept"], [])
        row = {"id": claim["id"], "concept": claim["concept"], "pages": slugs}
        if not slugs:
            rows.append({**row, "verdict": "absent", "quote": "", "reason": "no page for the concept"})
            continue
        text = "\n\n".join(f"# {candidate.by_slug[slug].get('title')}\n\n{candidate.by_slug[slug].get('body') or ''}" for slug in slugs)
        fact = {name: claim.get(name) for name in ("text", "numbers", "locator")}
        rows.append({**row, **judge("gold_claim", RECALL_INSTRUCTIONS, {"fact": fact, "page": _cut(text, PAGE_MAX_CHARS)}, RECALL_SCHEMA)})
    counts = {verdict: sum(1 for row in rows if row["verdict"] == verdict) for verdict in ("correct", "partial", "wrong", "absent")}
    return {"rows": rows, "summary": {
        "claims": len(rows), **counts,
        "recall": round(counts["correct"] / len(rows), 4) if rows else None,
        "recallWithPartial": round((counts["correct"] + counts["partial"]) / len(rows), 4) if rows else None,
    }}


SUPPORT_INSTRUCTIONS = """
You check a paragraph of a reader's Memory page against the passages it cites.
Split the paragraph into atomic claims: each a single factual, numerical or
causal statement. For each, answer `supported` when a cited passage entails
it, `unsupported` when the passages say something else, say less, or say it
under a condition the claim drops, or report as conjecture what the claim
states as a result, and `own` when the paragraph marks it as its own
inference or arithmetic ("it follows that", "by this page's calculation") or
it is connective prose that states no fact. Name the marker the claim cites,
or "" when it cites none. Judge only against the passages given.
""".strip()
SUPPORT_SCHEMA = _strict({
    "claims": {"type": "array", "items": _strict({
        "claim": {"type": "string"},
        "marker": {"type": "string"},
        "verdict": {"type": "string", "enum": ["supported", "unsupported", "own"]},
        "reason": {"type": "string"},
    })},
})


def supported_claim_rate(candidate: Candidate, *, judge: Judge, pages: Sequence[str] = ()) -> dict[str, Any]:
    """
    Faithfulness: of a page's atomic claims, how many does the cited passage entail?

    Every paragraph of a concept or domain page that carries a marker is one
    question: the paragraph, and for each marker its locator and the passage
    it names (a PDF page, a section, a note, a captured source), read from the
    candidate's files. The judge splits it into atomic claims and says of each
    whether a cited passage entails it. A paragraph whose every passage is
    missing is reported and not judged; `memory_eval` already says which
    citations do not resolve. The rate is supported over supported and
    unsupported: the page's own marked inference is neither.
    """
    read = Passages(candidate)
    rows = []
    for page in candidate.pages:
        if page.get("kind") == "source" or (pages and page["slug"] not in pages):
            continue
        cited = {int(citation["id"]): citation for citation in page.get("citations") or () if isinstance(citation.get("id"), int)}
        for number, paragraph in enumerate(blocks(page.get("body") or ""), start=1):
            markers = sorted({int(value) for value in MARKER.findall(paragraph)})
            if not markers:
                continue
            passages = []
            for marker in markers:
                citation = cited.get(marker)
                text = read(citation) if citation else None
                locator = {name: citation.get(name) for name in ("claimType", "paperId", "page", "section", "noteId", "evidenceId") if citation and citation.get(name)}
                passages.append({"marker": f"E{marker}", "locator": locator, "text": _cut(text, PASSAGE_MAX_CHARS) if text else None})
            row = {"id": f"{page['slug']}#{number}", "page": page["slug"], "paragraph": number}
            if all(passage["text"] is None for passage in passages):
                rows.append({**row, "claims": [], "unjudged": "no cited passage could be read"})
                continue
            answer = judge("supported_claims", SUPPORT_INSTRUCTIONS, {"paragraph": paragraph, "passages": passages}, SUPPORT_SCHEMA)
            rows.append({**row, "claims": answer["claims"]})
    claims = [claim for row in rows for claim in row["claims"]]
    counts = {verdict: sum(1 for claim in claims if claim["verdict"] == verdict) for verdict in ("supported", "unsupported", "own")}
    judged = counts["supported"] + counts["unsupported"]
    return {"rows": rows, "summary": {
        "paragraphs": len(rows), "unjudged": sum(1 for row in rows if row.get("unjudged")), "claims": len(claims), **counts,
        "supportedRate": round(counts["supported"] / judged, 4) if judged else None,
    }}


RUBRIC = ("orientation", "conceptRelations", "sourcesConnected", "readingOrder")
DOMAIN_INSTRUCTIONS = """
You score a domain page of a reader's Memory: the page that orients a reader
across the concept and source pages filed under one domain. You are given the
page, its members (title and summary), and a reviewed key of how the domain's
concepts depend on one another and how its sources relate. Score each aspect
0 (absent), 1 (partly) or 2 (done well), with one sentence of reason:
`orientation`: says what the domain is about and why these belong together;
`conceptRelations`: how the concepts depend on and differ from one another,
agreeing with the key; `sourcesConnected`: places each source, what it adds and
how it relates to the others, with evidence on both sides, agreeing with the
key, and states a disagreement as one; `readingOrder`: an order to read in, and
why. Then `linkList`: true when the page is mostly a list of its members with
a line each, which is the failure the page exists to replace.
""".strip()
DOMAIN_SCHEMA = _strict({
    **{aspect: _strict({"score": {"type": "integer", "enum": [0, 1, 2]}, "reason": {"type": "string"}}) for aspect in RUBRIC},
    "linkList": {"type": "boolean"},
})


def domain_rubric(candidate: Candidate, key: Mapping[str, Any], *, judge: Judge) -> dict[str, Any]:
    """
    Domain pages: orientation, concept relations, sources connected with evidence on both sides, reading order, not a link list.

    Every domain page is scored on that rubric, each aspect 0 to 2, against the
    key's `connections` for its domain (by slug; a key whose domains name none
    of the candidate's gives the judge every connection, and the report says
    so), and marked when it is only a list of links. A person scores the same
    pages in the release sample; a rubric line on which the judge and the
    person disagree is reported as unreliable and gates nothing.
    """
    connections = {str(entry.get("domain")): entry for entry in key.get("connections") or ()}
    rows = []
    for page in candidate.pages:
        if page.get("kind") != "domain":
            continue
        domain = str(page.get("domain") or page["slug"])
        members = [{"title": member.get("title"), "kind": member.get("kind"), "summary": member.get("summary")}
                   for member in candidate.pages if member.get("domain") == domain and member["slug"] != page["slug"]]
        held = connections.get(domain)
        payload = {"page": _cut(page.get("body") or "", PAGE_MAX_CHARS), "members": members,
                   "connections": [held] if held else list(connections.values())}
        answer = judge("domain_rubric", DOMAIN_INSTRUCTIONS, payload, DOMAIN_SCHEMA)
        rows.append({"id": page["slug"], "domain": domain, "keyedDomain": bool(held), **answer,
                     "total": sum(answer[aspect]["score"] for aspect in RUBRIC)})
    return {"rows": rows, "summary": {
        "domains": len(rows), "linkLists": sum(1 for row in rows if row["linkList"]),
        "meanTotal": round(statistics.mean(row["total"] for row in rows), 3) if rows else None, "outOf": 2 * len(RUBRIC),
    }}


PREFER_INSTRUCTIONS = """
You compare two sets of pages a reader's Memory holds on one idea, A and B,
written by two systems you are not told about. Prefer the set that would let
the reader explain the idea afterwards: correct mechanisms, the numbers that
matter with their conditions, where sources agree and disagree, and how the
idea connects to others. Penalise errors, unsupported claims and filler more
than omissions. Do not reward length. Answer `A`, `B` or `tie`, with one
sentence of reason.
""".strip()
PREFER_SCHEMA = _strict({"winner": {"type": "string", "enum": ["A", "B", "tie"]}, "reason": {"type": "string"}})


def pairwise_preference(
    old: Candidate, new: Candidate, key: Mapping[str, Any], *, judge: Judge,
    matched: tuple[Mapping[str, list[str]], Mapping[str, list[str]]] | None = None,
) -> dict[str, Any]:
    """
    Preference: blind, per topic, the old page set against the new one.

    For each inventory concept, the pages each candidate holds for it are
    shown unlabelled, once in each order, ties allowed. A concept one side has
    no page for is listed and not asked. Per concept the two orders are
    combined: new wins when it wins both or wins one and ties the other, and a
    split is a tie. `--runs` repeats it (the plan asks for five), and
    `--labels` takes the person-labelled subset of twenty pairs. `matched` is
    each side's concept pages (`match_concepts`); without it, the literal match.
    """
    held_old, held_new = matched if matched is not None else (inventory(old, dict(key))["pages"], inventory(new, dict(key))["pages"])

    def text(candidate: Candidate, slugs: Sequence[str]) -> str:
        return _cut("\n\n".join(f"# {candidate.by_slug[slug].get('title')}\n\n{candidate.by_slug[slug].get('body') or ''}" for slug in slugs), PAGE_MAX_CHARS)

    rows = []
    for concept in key.get("concepts") or ():
        old_slugs, new_slugs = held_old.get(concept["id"], []), held_new.get(concept["id"], [])
        if not old_slugs or not new_slugs:
            rows.append({"id": concept["id"], "winner": None, "missing": "old" if not old_slugs else "new"})
            continue
        first = judge("preference", PREFER_INSTRUCTIONS, {"idea": concept["title"], "A": text(old, old_slugs), "B": text(new, new_slugs)}, PREFER_SCHEMA)
        second = judge("preference", PREFER_INSTRUCTIONS, {"idea": concept["title"], "A": text(new, new_slugs), "B": text(old, old_slugs)}, PREFER_SCHEMA)
        votes = [{"A": "old", "B": "new"}.get(first["winner"], "tie"), {"A": "new", "B": "old"}.get(second["winner"], "tie")]
        score = votes.count("new") - votes.count("old")
        rows.append({"id": concept["id"], "winner": "new" if score > 0 else "old" if score < 0 else "tie",
                     "orders": votes, "reasons": [first["reason"], second["reason"]]})
    asked = [row for row in rows if row["winner"]]
    wins = {side: sum(1 for row in asked if row["winner"] == side) for side in ("new", "old", "tie")}
    return {"rows": rows, "summary": {
        "concepts": len(asked), "oneSided": len(rows) - len(asked), **wins,
        "newPreferred": round(wins["new"] / len(asked), 4) if asked else None,
    }}


EDIT_INSTRUCTIONS = """
You check one edit of a page in a reader's Memory. You are given the page
before and after the edit and the editor's one-line note of what it did.
List every statement of the earlier page that the later page has lost or
changed in meaning: a number, a unit, a condition, a hedge ("approximately",
"in their experiments"), an attribution to a source, a definition. Wording
that changed and kept the meaning is not a loss; a number written another way
is the same number. For each loss, say whether the note accounts for it (the
edit says it replaced or removed that statement, and why). Then `verdict`:
`kept` when nothing was lost that the note does not account for, `lost` otherwise.
""".strip()
EDIT_SCHEMA = _strict({
    "losses": {"type": "array", "items": _strict({
        "before": {"type": "string"}, "after": {"type": "string"}, "accountedFor": {"type": "boolean"},
    })},
    "verdict": {"type": "string", "enum": ["kept", "lost"]},
})


def edits_by_meaning(candidate: Candidate, *, judge: Judge) -> dict[str, Any]:
    """
    Edit safety by meaning: across each edit of a concept page, was anything lost the edit does not account for?

    Read from version history (`memory/versions/<slug>/`, or knowledge/ in a
    store before format 5), each revision against the one before, with the
    edit's note. The deterministic check (untouched blocks kept word for word)
    says a block changed; this says whether what it said survived, which a
    text match cannot.
    """
    kinds = {page["slug"]: page.get("kind") for page in candidate.pages}
    rows = []
    folder = candidate.memory / "versions"
    for history in sorted(folder.iterdir()) if folder.is_dir() else ():
        if kinds.get(history.name) != "concept":
            continue
        versions = [json.loads(path.read_text(encoding="utf-8")) for path in sorted(history.glob("*.json"))]
        for before, after in zip(versions, versions[1:]):
            payload = {"before": _cut(before.get("body") or "", PAGE_MAX_CHARS), "after": _cut(after.get("body") or "", PAGE_MAX_CHARS),
                       "note": after.get("note") or ""}
            answer = judge("edit_meaning", EDIT_INSTRUCTIONS, payload, EDIT_SCHEMA)
            rows.append({"id": f"{history.name}@{after.get('revision')}", "page": history.name, **answer,
                         "unaccounted": sum(1 for loss in answer["losses"] if not loss["accountedFor"])})
    return {"rows": rows, "summary": {
        "edits": len(rows), "kept": sum(1 for row in rows if row["verdict"] == "kept"),
        "unaccountedLosses": sum(row["unaccounted"] for row in rows),
    }}


# --- repeated runs and human agreement --------------------------------------------------

#: The field of a row that a person's label is compared with.
VERDICT_FIELD = {"recall": "verdict", "domains": "linkList", "prefer": "winner", "edits": "verdict"}


def spread(summaries: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Each numeric field of a metric's summary across runs: mean, lowest, highest."""
    numbers = {name for summary in summaries for name, value in summary.items() if isinstance(value, (int, float)) and not isinstance(value, bool)}
    out = {}
    for name in sorted(numbers):
        values = [summary[name] for summary in summaries if isinstance(summary.get(name), (int, float))]
        out[name] = {"mean": round(statistics.mean(values), 4), "min": min(values), "max": max(values)}
    return out


def agreement(rows: Sequence[Mapping[str, Any]], labels: Mapping[str, Any], field: str) -> dict[str, Any]:
    """How often the judge's verdict on an item is the person's label for it."""
    shared = [row for row in rows if row["id"] in labels]
    same = sum(1 for row in shared if row.get(field) == labels[row["id"]])
    return {"labelled": len(shared), "agree": same, "rate": round(same / len(shared), 4) if shared else None,
            "disagreements": [{"id": row["id"], "judge": row.get(field), "person": labels[row["id"]]} for row in shared if row.get(field) != labels[row["id"]]]}


def measure(metric: Callable[[], dict[str, Any]], *, runs: int = 1, labels: Mapping[str, Any] | None = None, field: str = "verdict") -> dict[str, Any]:
    """Run one metric `runs` times. The first run's rows are kept, every run's summary, their spread, and the agreement with people."""
    results = [metric() for _ in range(max(1, runs))]
    out: dict[str, Any] = {"runs": len(results), "summaries": [result["summary"] for result in results], "rows": results[0]["rows"]}
    if len(results) > 1:
        out["spread"] = spread(out["summaries"])
    if labels:
        out["agreement"] = [agreement(result["rows"], labels, field) for result in results]
    return out


# --- commands ---------------------------------------------------------------------------


def parser() -> argparse.ArgumentParser:
    made = argparse.ArgumentParser(description=(__doc__ or "").strip().split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = made.add_subparsers(dest="command", required=True)
    for name, told in (("recall", "gold-claim recall"), ("support", "supported-claim rate"), ("domains", "the domain rubric"),
                       ("prefer", "blind pairwise preference, old against new"), ("edits", "edit safety by meaning, from version history")):
        command = commands.add_parser(name, help=told, description=f"Measure {told} with a judge model. Every call is real money.")
        if name == "prefer":
            command.add_argument("--old", required=True, metavar="DIR")
            command.add_argument("--new", required=True, metavar="DIR")
        else:
            command.add_argument("--candidate", required=True, metavar="DIR")
        if name in ("recall", "domains", "prefer"):
            command.add_argument("--key", required=True, action="append", metavar="KEY", help="a key file; repeat for more")
        if name == "support":
            command.add_argument("--pages", default="", help="only these slugs, comma-separated")
        command.add_argument("--user", help="the account, when a directory holds more than one")
        command.add_argument("--model", required=True, help="the judge: a model that did not write the pages")
        command.add_argument("--runs", type=int, default=1, help="repeat, and report each number's spread")
        command.add_argument("--labels", metavar="JSON", help="a person's verdicts by item id, to report agreement with")
        if name in ("recall", "prefer"):
            command.add_argument("--match", choices=("judge", "names"), default="judge",
                                 help="find each concept's pages by meaning (one judge question per candidate, the default) or by the key's names only")
        command.add_argument("--out", required=True, metavar="FILE")
    return made


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    judge = ResponsesJudge(args.model)
    key: dict[str, Any] = {}
    if getattr(args, "key", None):
        key, problems = load_keys(args.key)
        if problems:
            print("\n".join(problems), file=sys.stderr)
            return 2
    matches: dict[str, Any] = {}
    if args.command == "prefer":
        old, new = load_candidate(args.old, args.user), load_candidate(args.new, args.user)
        if args.match == "judge":
            matches = {"old": match_concepts(old, key, judge=judge), "new": match_concepts(new, key, judge=judge)}
        pair = (matches["old"], matches["new"]) if matches else None
        metric = lambda: pairwise_preference(old, new, key, judge=judge, matched=pair)  # noqa: E731
    else:
        candidate = load_candidate(args.candidate, args.user)
        if args.command == "recall" and args.match == "judge":
            matches = {"candidate": match_concepts(candidate, key, judge=judge)}
        metric = {
            "recall": lambda: gold_claim_recall(candidate, key, judge=judge, matched=matches.get("candidate")),
            "support": lambda: supported_claim_rate(candidate, judge=judge, pages=[slug for slug in args.pages.split(",") if slug]),
            "domains": lambda: domain_rubric(candidate, key, judge=judge),
            "edits": lambda: edits_by_meaning(candidate, judge=judge),
        }[args.command]
    labels = json.loads(Path(args.labels).read_text(encoding="utf-8")) if args.labels else None
    result = measure(metric, runs=args.runs, labels=labels, field=VERDICT_FIELD.get(args.command, "verdict"))
    if matches:
        result["conceptPages"] = matches
    result.update({"metric": args.command, "model": args.model, "calls": judge.calls,
                   "keysReviewed": key.get("reviewed") if key else None})
    Path(args.out).write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"metric": args.command, "runs": result["runs"], "calls": judge.calls, "summary": result["summaries"][0]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
