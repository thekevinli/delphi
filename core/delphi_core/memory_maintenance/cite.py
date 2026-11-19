"""
New citations, held to a run's closed evidence set.

A maintenance run may cite only what it was handed (`staging.Evidence`, by
id). A new citation is a mapping with `ref` (`N1`), `claimType` and the
locator fields, and what it must name depends on its type:

    author-claim   a document of the evidence set, and a page it has (a PDF)
                   or a section it has (a saved page)
    external       a captured outside source of the evidence set, and a section
    reader-note    a document, and a note the reader wrote on it
    derived        nothing: it is Delphi's own inference

An invented locator is a false statement about a source, so it is refused and
never repaired. The one thing settled quietly is spelling: a section is stored
as its source spells it.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from .staging import Evidence

#: Ids or sections a refusal lists, so the agent can pick a real one.
LISTED_MAX = 12

_LOCATORS = ("paperId", "page", "section", "noteId", "evidenceId")


def _listed(names: Iterable[str]) -> str:
    names = list(names)
    more = f", and {len(names) - LISTED_MAX} more" if len(names) > LISTED_MAX else ""
    return ", ".join(names[:LISTED_MAX]) + more


def _source(ref: str, entry: Mapping[str, Any], evidence: Mapping[str, Evidence], kind: str) -> tuple[Evidence | None, str | None]:
    field, noun = ("evidenceId", "outside source") if kind == "external" else ("paperId", "document")
    named = entry.get(field)
    if not named:
        return None, f"Citation {ref} is {entry.get('claimType')} and names no {noun}; give its `{field}`."
    found = evidence.get(named)
    if found is None or found.kind != kind:
        have = _listed(item.id for item in evidence.values() if item.kind == kind)
        return None, (
            f"Citation {ref} names the {noun} {named!r}, which is not in this run's evidence; "
            + (f"cite only what the evidence lists: {have}." if have else f"this run has no {noun} to cite.")
        )
    return found, None


def _section(ref: str, entry: Mapping[str, Any], source: Evidence) -> tuple[str | None, str | None]:
    """The source's own spelling of the section a citation names, or the problem."""
    sections = source.sections or ()
    anchor = str(entry.get("section") or "").lstrip("#§")
    canonical = {item.casefold(): item for item in sections}.get(anchor.casefold())
    if canonical is None and not anchor and len(sections) == 1:
        canonical = sections[0]
    if canonical is None and entry.get("page") and f"page-{entry['page']}" in sections:
        # A linked PDF is read by section, and its sections are its pages.
        canonical = f"page-{entry['page']}"
    if canonical is None:
        return None, (
            f"Citation {ref} cites section {anchor!r} of {source.title or source.id!r}, which has no such "
            f"section; its sections are: {_listed(sections)}."
        )
    return canonical, None


def check_citations(
    citations: Sequence[Mapping[str, Any]], evidence: Mapping[str, Evidence]
) -> tuple[list[dict[str, Any]], list[str]]:
    """
    New citations held to the evidence set (see the module docstring).

    Returns each as `ref`, `claimType` and the locator its type takes, with a
    section in its source's own spelling, and one sentence for each that is
    wrong. A field the type does not take is left out, not refused.
    """
    checked: list[dict[str, Any]] = []
    problems: list[str] = []
    for entry in citations:
        ref, kind = entry.get("ref"), entry.get("claimType")
        kept: dict[str, Any] = {"ref": ref, "claimType": kind, **{name: None for name in _LOCATORS}}
        problem = None
        if kind == "derived":
            named = [name for name in _LOCATORS if entry.get(name)]
            if named:
                problem = (
                    f"Citation {ref} is derived, which is Delphi's own inference, and names a source "
                    f"({', '.join(named)}); leave those empty, or give the claim type of what the source says."
                )
        elif kind == "author-claim":
            source, problem = _source(ref, entry, evidence, "document")
            if source is not None:
                kept["paperId"] = source.id
                if source.sections is not None:
                    kept["section"], problem = _section(ref, entry, source)
                    kept["page"] = entry.get("page") or None
                elif not isinstance(entry.get("page"), int) or not 1 <= entry["page"] <= source.pages:
                    problem = (
                        f"Citation {ref} cites page {entry.get('page') or 'none'} of {source.title or source.id!r}, "
                        f"which has pages 1 to {source.pages}."
                    )
                elif source.via and entry["page"] not in source.only_pages:
                    problem = (
                        f"Citation {ref} cites page {entry['page']} of {source.title or source.id!r}, which this run "
                        f"reaches only through Memory: cite it at a page the pages near this one cite it at, "
                        f"{', '.join(str(page) for page in sorted(source.only_pages))}."
                    )
                else:
                    kept["page"], kept["section"] = entry["page"], entry.get("section") or None
        elif kind == "external":
            source, problem = _source(ref, entry, evidence, "external")
            if source is not None:
                kept["evidenceId"] = source.id
                kept["section"], problem = _section(ref, entry, source)
        elif kind == "reader-note":
            source, problem = _source(ref, entry, evidence, "document")
            if source is not None:
                kept["paperId"], kept["noteId"] = source.id, entry.get("noteId") or None
                if kept["noteId"] not in source.notes:
                    problem = (
                        f"Citation {ref} cites note {entry.get('noteId') or ''!r} of {source.title or source.id!r}, "
                        "which is not a note the reader wrote on it."
                    )
        else:
            problem = f"Citation {ref} has the claim type {kind!r}; it is author-claim, external, derived or reader-note."
        if problem:
            problems.append(problem)
        checked.append(kept)
    return checked, problems
