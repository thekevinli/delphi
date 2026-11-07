"""
What a write to Memory must pass before it is staged.

The two write tools are adapters over this module: each parses a call and
hands it here. `stage_edit` and `stage_create` run every deterministic check
(`ops.py` applies the operations, `validate.py` judges the result,
`cite.py` holds the citations to the run's closed evidence set, and
`reader_notes.py` holds what rests on a reader's note to its citation), and
then either stage the page in the run's `MemoryDraft` or refuse. Both return the text the agent
reads. A refusal starts `Error:` and says, one sentence for each thing that is
wrong, what to change; nothing is staged by a call that is refused.

Two pages are the same name when their titles or aliases are equal as slugs
(`memory_slug`), which is how a `[[link]]` would resolve either of them.

The domain composer stages through the same two doors. It names the kind it
writes and that kind's limits (`kind`, `limits`), and a domain's page is
staged whole by `stage_page`, under the domain's own slug and name.

Nothing here reads storage, calls a model or knows a tool: the same-idea check
is a model call, so the caller makes it and passes what it answered.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping, Sequence
from typing import Any

from ..storage.base import memory_slug
from .cite import check_citations
from .ops import apply_operations
from . import reader_notes
from .staging import ExistingPage, MemoryDraft, StagedPage
from .validate import (
    CONCEPT_LIMITS,
    BodyLimits,
    WITHDRAWN,
    calculation_problems,
    preservation_problems,
    repair_links,
    shape_problems,
)

#: The only kind a write tool writes. A source page is its document's digest
#: and a domain page is its composer's, which names `domain` when it stages.
WRITTEN_KIND = "concept"
TITLE_MAX_CHARS = 200
SUMMARY_MAX_CHARS = 1_600
NOTE_MAX_CHARS = 300
ALIASES_MAX = 12
ALIAS_MAX_CHARS = 120
_WHY_NOT_EDITED = {
    "source": "a source page is its document's digest and is never edited",
    "domain": "a domain page is written by its own pass",
}


def _refused(problems: Sequence[str], what: str = "") -> str:
    if len(problems) == 1 and not what:
        return f"Error: {problems[0]}"
    return f"Error: {what or 'the call'} was not staged. Fix each of these and call again:\n" + "\n".join(
        f"- {problem}" for problem in problems
    )


def _names(title: str, aliases: Iterable[str]) -> set[str]:
    return {slug for name in (title, *aliases) if (slug := memory_slug(name))}


def name_problem(names: Iterable[str], pages: Iterable[ExistingPage], *, own: str = "") -> str | None:
    """The page that already has one of these names, said as a refusal, or None."""
    for name in names:
        wanted = memory_slug(name)
        for page in pages:
            if wanted and page.slug != own and wanted in {page.slug, *_names(page.title, page.aliases)}:
                return (
                    f"{name!r} is already the page [[{page.slug}]] ({page.title}), by its title or an alias. "
                    "Open that page and edit it; a second page for the same name is never created."
                )
    return None


def _aliases(aliases: Iterable[str], title: str) -> tuple[tuple[str, ...], list[str]]:
    kept: dict[str, str] = {}
    for alias in aliases:
        alias = " ".join(str(alias).split())
        if alias and memory_slug(alias) and memory_slug(alias) != memory_slug(title):
            kept.setdefault(memory_slug(alias), alias)
    long = [alias for alias in kept.values() if len(alias) > ALIAS_MAX_CHARS]
    problems = [f"An alias is {len(long[0])} characters; an alias is a name, at most {ALIAS_MAX_CHARS}."] if long else []
    if len(kept) > ALIASES_MAX:
        problems.append(f"The page would have {len(kept)} aliases; keep the {ALIASES_MAX} a reader would search for.")
    return tuple(kept.values()), problems


def _texts(summary: str, note: str, *, summary_needed: bool) -> list[str]:
    problems = []
    if summary_needed and not summary:
        problems.append("The page has no `summary`; say in a sentence or two what the page explains.")
    if len(summary) > SUMMARY_MAX_CHARS:
        problems.append(f"The summary is {len(summary):,} characters; it is at most {SUMMARY_MAX_CHARS:,}.")
    if not note:
        problems.append("The call has no `note`; say in one line what this write does to the page.")
    elif len(note) > NOTE_MAX_CHARS:
        problems.append(f"The note is {len(note)} characters; it is one line, at most {NOTE_MAX_CHARS}.")
    return problems


def _finish(draft: MemoryDraft, page: StagedPage, done: str) -> str:
    replaced = draft.stage(page)
    said = [done]
    if page.refs:
        said.append("New citations: " + ", ".join(f"{ref} is [E{number}]" for ref, number in page.refs.items()) + ".")
    if page.repaired:
        said.append(
            "No page exists for " + ", ".join(f"[[{slug}]]" for slug in page.repaired) + ", so each was written "
            "as plain words, not a link. If a link is wanted, create that page first and make this call again."
        )
    if replaced is not None:
        said.append("This replaces what was staged for the page earlier in this run.")
    said.append(
        f"{len(draft.staged)} of {draft.max_pages} pages staged. Nothing is stored until the run has ended "
        "and the page has been checked."
    )
    return " ".join(said)


def stage_edit(
    draft: MemoryDraft,
    pages: Sequence[ExistingPage],
    *,
    slug: str,
    operations: Sequence[Mapping[str, Any]],
    citations: Sequence[Mapping[str, Any]] = (),
    calculations: Sequence[Mapping[str, Any]] = (),
    summary: str = "",
    aliases: Sequence[str] = (),
    note: str,
    kind: str = WRITTEN_KIND,
    limits: BodyLimits = CONCEPT_LIMITS,
) -> str:
    """Check an edit to a page the run was shown, and stage the result or say why not."""
    slug = memory_slug(str(slug).rsplit("/", 1)[-1])
    if problem := draft.full_problem(slug):
        return _refused([problem])
    shown = draft.shown.get(slug)
    if shown is None:
        if slug in draft.created:
            return _refused([
                f"`{slug}` is a page this run is creating, so there is no stored page to edit; to change it, "
                "call create_memory again with the whole page."
            ])
        return _refused([
            f"`{slug}` has not been opened in this run; open it with open_memory, then address its blocks "
            "by the labels that shows."
        ])
    if shown.kind != kind:
        why = _WHY_NOT_EDITED.get(shown.kind, f"only a {kind} page is edited")
        return _refused([f"`{slug}` is a {shown.kind} page: {why}. Put what you have into a {kind} page."])
    summary, note = summary.strip(), " ".join(note.split())
    added, problems = _aliases([*shown.aliases, *aliases], shown.title)
    fresh = [alias for alias in added if memory_slug(alias) not in _names("", shown.aliases)]
    if not operations and not summary and not fresh:
        return _refused([f"The call changes nothing on `{slug}`; give an operation, a new summary or a new alias."])
    new, cited = check_citations(citations, draft.evidence)
    edit = apply_operations(shown.body, operations, citations=shown.citations, new_citations=new)
    what = f"the edit to `{slug}`"
    if not edit.ok:
        return _refused([*edit.problems, *cited], what)
    problems += cited + _texts(summary, note, summary_needed=False)
    problems += [
        f"[E{item['id']}] cites the note {item['noteId']!r}, which the reader has deleted, so it is no longer "
        f"evidence. Delete or replace what rests only on it with the reason `{WITHDRAWN}`, or cite another "
        f"source of this run for it, so that no [E{item['id']}] is left on the page."
        for item in edit.citations if item.get("noteId") in draft.gone_notes
    ]
    known = {str(item["ref"]): item for item in new} | {f"E{item['id']}": item for item in shown.citations}
    problems += preservation_problems(shown.body, edit.changes, evidence=set(known), keep_words=kind == WRITTEN_KIND)
    problems += reader_notes.unrested(reader_notes.written(shown.body, edit.changes), known, draft.notes)
    problems += calculation_problems(calculations, citations=set(known))
    if clash := name_problem(fresh, pages, own=slug):
        problems.append(clash)
    resolves = {page.slug for page in pages} | draft.created | {slug}
    # A link the page already had with no page behind it is not this edit's to
    # repair: repairing it would rewrite a block the edit did not name.
    resolves |= set(repair_links(shown.body, resolves)[1])
    body, repaired = repair_links(edit.body, resolves)
    problems += reader_notes.kept_problems(
        shown.body, shown.citations, draft.gone_notes, body, edit.citations,
        {note for source in draft.evidence.values() for note in source.notes},
    )
    # A defect the page already had, in a block the edit did not name, is not
    # this edit's to fix. One in the text the edit wrote is, whatever the page had.
    before = shape_problems(shown.body, limits)
    shape = [problem for problem in shape_problems(body, limits) if problem not in before]
    # A `replace_text` writes a fragment, which cannot be judged apart from its block.
    written = "\n\n".join(change.after for change in edit.changes if change.after and change.op != "replace_text")
    for problem in shape_problems(written, limits) if written else ():
        if not problem.startswith("The page body") and problem not in shape:
            shape.append(problem)
    problems += shape
    if problems:
        return _refused(problems, what)
    stated = {name: known[name] for change in edit.changes for name in change.evidence if name in known}
    page = StagedPage(
        slug=slug, action="edit", revision=shown.revision, title=shown.title, aliases=added,
        domain=shown.domain, summary=summary or shown.summary, body=body, citations=edit.citations,
        figures=shown.figures, kind=kind, note=note, changes=edit.changes, refs=dict(edit.refs),
        evidence={name: {key: value for key, value in item.items() if key not in {"ref", "id"}} for name, item in stated.items()},
        calculations=tuple(dict(entry) for entry in calculations), repaired=tuple(repaired),
    )
    done = (
        f"Staged the edit to `{slug}` as read at revision {shown.revision}: {len(edit.changes)} "
        f"operation{'' if len(edit.changes) == 1 else 's'}, {len(shown.body):,} to {len(body):,} characters."
    )
    if edit.dropped:
        done += " No longer cited, and dropped: " + ", ".join(f"[E{number}]" for number in edit.dropped) + "."
    return _finish(draft, page, done)


def create_gate(
    draft: MemoryDraft, pages: Sequence[ExistingPage], *, title: str, aliases: Sequence[str]
) -> tuple[str, str | None]:
    """The slug a new page would have, and why it cannot be created, before anything is asked of a model."""
    title = " ".join(title.split())
    slug = memory_slug(title)
    if not slug or len(title) > TITLE_MAX_CHARS:
        return slug, _refused([f"A page needs a title of letters or digits, at most {TITLE_MAX_CHARS} characters."])
    if problem := draft.full_problem(slug):
        return slug, _refused([problem])
    # Pages this run is creating are names too, though no store has them yet.
    creating = [
        ExistingPage(page.slug, page.title, WRITTEN_KIND, page.aliases)
        for page in draft.staged if page.action == "create" and page.slug != slug
    ]
    problem = name_problem([title, *aliases], [*pages, *creating])
    return slug, _refused([problem]) if problem else None


def stage_create(
    draft: MemoryDraft,
    pages: Sequence[ExistingPage],
    *,
    title: str,
    aliases: Sequence[str] = (),
    domain: str,
    summary: str,
    body: str,
    citations: Sequence[Mapping[str, Any]] = (),
    calculations: Sequence[Mapping[str, Any]] = (),
    note: str,
    same_idea: Sequence[str] = (),
    distinct_from: Sequence[str] = (),
    distinct_reason: str = "",
) -> str:
    """
    Check a new concept page and stage it, or say why not. `same_idea` is what
    the same-idea check answered: slugs of pages that may already explain it.
    """
    slug, refusal = create_gate(draft, pages, title=title, aliases=aliases)
    if refusal:
        return refusal
    by_slug = {page.slug: page for page in pages}
    candidates = [name for name in dict.fromkeys(same_idea) if name in by_slug and by_slug[name].kind == WRITTEN_KIND]
    distinct = tuple(name for raw in dict.fromkeys(distinct_from) if (name := memory_slug(str(raw).rsplit("/", 1)[-1])) in by_slug)
    reason = " ".join(distinct_reason.split())
    if candidates and (not reason or any(name not in distinct for name in candidates)):
        return _refused([
            "These pages may already explain this idea: "
            + ", ".join(f"[[{name}]] ({by_slug[name].title})" for name in candidates)
            + ". Open them with open_memory and edit the one that does. If this is a different idea, call "
            "create_memory again with every one of them in `distinctFrom` and one sentence in "
            "`distinctReason` saying how it differs."
        ])
    return stage_page(
        draft, set(by_slug), slug=slug, title=title, aliases=aliases, domain=domain, summary=summary, body=body,
        citations=citations, calculations=calculations, note=note, distinct_from=distinct,
        distinct_reason=reason if distinct else "",
    )


def stage_page(
    draft: MemoryDraft,
    existing: Collection[str],
    *,
    slug: str,
    title: str,
    domain: str,
    summary: str,
    body: str,
    note: str,
    aliases: Sequence[str] = (),
    citations: Sequence[Mapping[str, Any]] = (),
    calculations: Sequence[Mapping[str, Any]] = (),
    distinct_from: Sequence[str] = (),
    distinct_reason: str = "",
    kind: str = WRITTEN_KIND,
    limits: BodyLimits = CONCEPT_LIMITS,
) -> str:
    """
    Check a whole new page under a slug its caller has settled, and stage it or say why not.

    `existing` are the slugs a `[[link]]` in it may name. Whether the page may
    exist at all (its name, the same-idea check) is the caller's to decide
    first: `stage_create` does for a concept page.
    """
    title, summary, note = " ".join(title.split()), summary.strip(), " ".join(note.split())
    kept, problems = _aliases(aliases, title)
    problems += _texts(summary, note, summary_needed=True)
    area = memory_slug(domain)
    if not area:
        problems.append("The page names no `domain`; give the domain it belongs to, as the index spells it.")
    new, cited = check_citations(citations, draft.evidence)
    what = f"the new page `{slug}`"
    if not body.strip():
        return _refused([*problems, *cited, "The page has no `body`."], what)
    edit = apply_operations("", [{"op": "insert_after", "block": "start", "markdown": body}], new_citations=new)
    if not edit.ok:
        said = [problem.replace("Operation 1 (insert_after)", "The body") for problem in edit.problems]
        return _refused([*problems, *said, *cited], what)
    problems += cited + calculation_problems(calculations, citations={str(item["ref"]) for item in new})
    problems += reader_notes.unrested(reader_notes.created(body), {str(item["ref"]): item for item in new}, draft.notes)
    text, repaired = repair_links(edit.body, set(existing) | draft.created | {slug})
    problems += shape_problems(text, limits)
    if problems:
        return _refused(problems, what)
    page = StagedPage(
        slug=slug, action="create", revision=0, title=title, aliases=kept, domain=area,
        domain_title=" ".join(domain.split()), summary=summary,
        body=text, citations=edit.citations, kind=kind, note=note, refs=dict(edit.refs),
        calculations=tuple(dict(entry) for entry in calculations), repaired=tuple(repaired),
        distinct_from=tuple(distinct_from), distinct_reason=distinct_reason,
    )
    return _finish(draft, page, f"Staged the new {kind} page `{slug}` ({title}) in {area}: {len(text):,} characters.")
