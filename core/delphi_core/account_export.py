"""
The whole account as one folder a person, or an agent, can take anywhere.

This is the reader's copy of their work for the day Delphi is not there to
open it. So it targets no one application: no vault format, no importer. It
is plain files in a fixed layout, a `README.md` saying what each one is, a
`manifest.json` naming every one, and an `index.html` that opens from disk
with no server. Turning that into an Obsidian vault or a Notion import is a
small job for whoever needs it; guessing at it here would be a second product.

What goes in is what the reader made or chose: their documents as they added
them, the digests, highlights and notes, every conversation, the Memory wiki
with its figures and the outside pages it cites, their personas and plans.
What stays out is Delphi's own bookkeeping — page history, the filing log, the
queue, the search index — because none of it means anything without Delphi.

Every reference is resolved to a relative path inside the folder, because a
`[[slug]]`, a `figure:<id>` and an `[E3]` all name things only Delphi can find.
A citation becomes a footnote that opens the cited page of the cited file.

It reads through `Storage` and `ObjectStore` alone, so every product exports
the same folder from its own stores, and writes the zip to a file the caller
owns: a library's PDFs are hundreds of megabytes and must never be one
allocation.
"""

from __future__ import annotations

import base64
import json
import posixpath
import re
import zipfile
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote as quote_url

from fastapi import HTTPException

from .config import Settings
from .harness.evidence import as_markdown as evidence_markdown
from .harness.evidence import load_sections as load_evidence_sections
from .memory import MARKER, _embed_digest_assets
from .plan_page import render_plan
from .research_digest import digest_asset_key
from .storage import ObjectStore, Storage, paper_key
from .storage.base import FIGURE_REF

#: Named in the manifest so a later layout can be told from this one.
FORMAT = "delphi-export/1"
#: `storage.base.WIKI_LINK`, with the label kept: a link is written as its words.
_LINK = re.compile(r"\[\[([^\[\]|]{1,120})(?:\|([^\[\]]{0,120}))?\]\]")
#: Where an answer says a plan was saved; the export holds the page itself.
_PLAN_URL = re.compile(r"/api/plans/([A-Za-z0-9_-]+)/view")
#: Already compressed; deflating them again costs time and saves nothing.
_STORED = (".pdf", ".webp", ".png", ".jpg")
#: Every conversation the account holds; the listing's own default is the Dashboard's five.
_ALL = 1_000_000

CLAIM_LABELS = {"external": "outside source", "reader-note": "your note", "derived": "inference"}


def write_export(
    storage: Storage, objects: ObjectStore, settings: Settings, username: str, path: str, *, now: datetime | None = None
) -> str:
    """Write the account's export to `path` as a zip; answer the file name it should be saved under."""
    now = now or datetime.now(UTC)
    root = f"delphi-export-{now:%Y-%m-%d}"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        Export(storage, objects, settings, username, _Archive(archive, root, now), now).write()
    return f"{root}.zip"


class _Archive:
    """The zip, under one root folder, with names that never collide."""

    def __init__(self, archive: zipfile.ZipFile, root: str, now: datetime) -> None:
        self.archive, self.root, self.taken = archive, root, set()
        self.date_time = now.timetuple()[:6]

    def unique(self, folder: str, stem: str, suffix: str = "") -> str:
        name, n = f"{folder}/{stem}{suffix}", 1
        while name.lower() in self.taken:
            n += 1
            name = f"{folder}/{stem}-{n}{suffix}"
        self.taken.add(name.lower())
        return name

    def text(self, name: str, content: str) -> None:
        self.archive.writestr(f"{self.root}/{name}", content)

    def copy(self, objects: ObjectStore, key: str, name: str) -> bool:
        """Stream one object in; False when its bytes are gone, which must not fail the export."""
        try:
            # `open_range` raises before the first chunk, so a missing object leaves no entry.
            chunks = objects.open_range(key)
        except (HTTPException, OSError):
            return False
        info = zipfile.ZipInfo(f"{self.root}/{name}", date_time=self.date_time)
        info.compress_type = zipfile.ZIP_STORED if name.endswith(_STORED) else zipfile.ZIP_DEFLATED
        with self.archive.open(info, "w", force_zip64=True) as target:
            for chunk in chunks:
                target.write(chunk)
        return True


def slug(text: str | None, fallback: str) -> str:
    """A file name a reader recognises: the title's own words, any script, nothing a filesystem refuses."""
    cleaned = re.sub(r"[\W_]+", "-", (text or "").lower()).strip("-")[:60].rstrip("-")
    return cleaned or fallback


def relative(target: str, source_file: str) -> str:
    return posixpath.relpath(target, posixpath.dirname(source_file) or ".")


def frontmatter(fields: dict[str, Any]) -> str:
    # JSON is YAML for every scalar and list, and quoting each value means a
    # title with a colon or a leading dash cannot become something else.
    lines = [f"{key}: {json.dumps(value, ensure_ascii=False)}" for key, value in fields.items() if value not in (None, "", [])]
    return "---\n" + "\n".join(lines) + "\n---\n\n"


def utf16_slice(text: str, start: int, end: int | None = None) -> str:
    """A stretch's offset counts UTF-16 units (`answer_trace`), as a browser slices."""
    data = text.encode("utf-16-le")
    return data[2 * start: None if end is None else 2 * end].decode("utf-16-le", errors="ignore")


class Export:
    def __init__(self, storage: Storage, objects: ObjectStore, settings: Settings, username: str,
                 archive: _Archive, now: datetime) -> None:
        self.storage, self.objects, self.settings, self.username = storage, objects, settings, username
        self.archive, self.now = archive, now
        self.documents: dict[str, dict[str, Any]] = {}  # paper id → its entry in the manifest
        self.note_papers: dict[str, str] = {}  # note id → paper id
        self.pages: dict[str, dict[str, Any]] = {}  # slug → its entry
        self.evidence: dict[str, str | None] = {}  # evidence id → the capture as Markdown, None when gone
        self.figure_files: dict[str, str | None] = {}  # figure id → its file; pages share figures
        self.manifest: dict[str, Any] = {
            "format": FORMAT, "exportedAt": now.isoformat(), "account": username,
            "projects": [], "memory": {"domains": []}, "chats": [], "personas": [], "plans": [],
        }

    def write(self) -> None:
        # Every path is decided before anything is written, so a page can link
        # a document, and a chat file can sit in its document's folder.
        projects = self.storage.list_projects_with_papers(self.username)
        self.lay_out_library(projects)
        pages = self.lay_out_memory() if self.settings.memory_enabled else []
        for project in projects:
            for paper in project.get("papers") or []:
                self.write_document(project, paper)
        self.write_plans()
        self.write_chats()
        for page in pages:
            self.write_page(page)
        self.write_evidence()
        self.write_personas()
        self.archive.text("manifest.json", json.dumps(self.manifest, ensure_ascii=False, indent=2))
        self.archive.text("README.md", README)
        self.archive.text("index.html", index_html(self.manifest))

    # --- the library --------------------------------------------------------

    def lay_out_library(self, projects: list[dict[str, Any]]) -> None:
        for project in projects:
            folder = self.archive.unique("library", slug(project.get("name"), project["id"]))
            entry = {"id": project["id"], "name": project.get("name"), "createdAt": project.get("createdAt"),
                     "path": folder, "documents": []}
            for paper in project.get("papers") or []:
                document = {
                    "id": paper["id"], "title": paper.get("title"), "kind": paper.get("kind") or "pdf",
                    "url": paper.get("url") or paper.get("sourceUrl"), "pages": paper.get("pages"),
                    "addedAt": paper.get("createdAt"), "readAt": paper.get("doneAt"),
                    "path": self.archive.unique(folder, slug(paper.get("title"), paper["id"])),
                    "files": {}, "highlights": 0, "notes": 0, "chats": [],
                }
                entry["documents"].append(document)
                self.documents[paper["id"]] = document
            self.manifest["projects"].append(entry)

    def write_document(self, project: dict[str, Any], paper: dict[str, Any]) -> None:
        document, project_id = self.documents[paper["id"]], project["id"]
        folder, files = document["path"], document["files"]

        def key(ext: str) -> str:
            return paper_key(self.username, project_id, paper["id"], ext)

        if document["kind"] != "web" and self.archive.copy(self.objects, key("pdf"), f"{folder}/source.pdf"):
            files["source"] = f"{folder}/source.pdf"
        snapshot = self.json_object(key("web")) if document["kind"] == "web" else None
        if snapshot and snapshot.get("savedDom"):
            # The page copy is stored script-free (`web_revision.freeze`); its
            # styles and images still load from the site while it is up.
            self.archive.text(f"{folder}/page.html", snapshot["savedDom"])
            files["page"] = f"{folder}/page.html"
        text = self.text_object(key("txt"))
        if text:
            self.archive.text(f"{folder}/text.md", text)
            files["text"] = f"{folder}/text.md"
        self.write_annotations(project_id, paper, document)
        record = self.json_object(key("digest"))
        files["document"] = f"{folder}/document.md"
        self.archive.text(files["document"], self.document_markdown(project, paper, document, record))

    def document_markdown(self, project: dict[str, Any], paper: dict[str, Any], document: dict[str, Any],
                          record: dict[str, Any] | None) -> str:
        head = frontmatter({
            "title": document["title"], "id": paper["id"], "kind": document["kind"], "project": project.get("name"),
            "url": document["url"], "pages": document["pages"], "added": document["addedAt"], "read": document["readAt"],
        }) + f"# {document['title']}\n\n"
        digest = (record or {}).get("digest") or {}
        body = digest.get("contentMarkdown")
        if not body:
            return head + "_Delphi wrote no digest for this document._\n"
        here, figures = document["files"]["document"], {}
        placements = []
        for asset in digest.get("assets") or []:
            name = f"{document['path']}/assets/{asset['id']}.{'svg' if asset.get('mimeType') == 'image/svg+xml' else 'webp'}"
            source = digest_asset_key(self.username, project["id"], paper["id"], asset["id"], asset.get("mimeType") or "")
            if self.archive.copy(self.objects, source, name):
                figures[asset["id"]] = (name, asset.get("caption") or asset.get("alt") or "")
                placements.append((asset.get("afterEvidenceId"), asset["id"]))
        # The reader's digest view places each asset after the paragraph its
        # evidence sits in; a file has no such channel, so do what the source page does.
        body = _embed_digest_assets(body, placements, ceiling=len(body) * 4 + 100_000)
        body = self.figures(body, here, figures)
        citations = [{**citation, "paperId": citation.get("paperId") or paper["id"]} for citation in digest.get("citations") or []]
        return head + self.cite(body, citations, here) + "\n"

    def write_annotations(self, project_id: str, paper: dict[str, Any], document: dict[str, Any]) -> None:
        highlights = self.storage.list_highlights(self.username, project_id, paper["id"])
        notes = self.storage.list_notes(self.username, project_id, paper["id"])
        document["highlights"], document["notes"] = len(highlights), len(notes)
        for note in notes:
            self.note_papers[note["id"]] = paper["id"]
        if not highlights and not notes:
            return
        by_highlight: dict[str, list[dict[str, Any]]] = {}
        for note in notes:
            by_highlight.setdefault(note.get("highlightId") or "", []).append(note)
        lines = [f"# Annotations: {document['title']}", ""]
        ordered = sorted(highlights, key=lambda h: (h.get("page") or 0, h.get("createdAt") or ""))
        for highlight in ordered:
            where = f"p. {highlight['page']}" if highlight.get("page") else "Highlight"
            lines += [f"## {where}", "", *quote(highlight.get("text") or ""), ""]
            for note in by_highlight.pop(highlight["id"], []):
                lines += note_lines(note)
        for orphans in by_highlight.values():
            for note in orphans:
                lines += [*quote(note.get("quotedText") or ""), ""] + note_lines(note)
        folder = document["path"]
        self.archive.text(f"{folder}/annotations.md", "\n".join(lines).rstrip() + "\n")
        # Exact positions — PDF rectangles, HTML anchors — so nothing is lost
        # that a later tool could place again.
        self.archive.text(f"{folder}/annotations.json", json.dumps(
            {"highlights": highlights, "notes": notes}, ensure_ascii=False, indent=2, default=str))
        document["files"]["annotations"] = f"{folder}/annotations.md"

    # --- conversations ------------------------------------------------------

    def write_chats(self) -> None:
        rows = self.storage.list_recent_conversations(self.username, limit=_ALL)
        for row in sorted(rows, key=lambda r: (r.get("createdAt") or "", r["id"])):
            conversation = self.storage.get_conversation(self.username, row["id"])
            messages = conversation.get("messages") or []
            if not messages:
                continue
            document = self.documents.get(conversation.get("paperId") or "")
            about = conversation.get("kind") == "document_chat"
            title = conversation.get("title") or (messages[0].get("content") or "").split("\n")[0][:60]
            folder = f"{document['path']}/chats" if document else "chats"
            started = conversation.get("createdAt") or messages[0].get("createdAt") or ""
            name = self.archive.unique(folder, f"{started[:10]}-{slug(title, conversation['id'])}".lstrip("-"), ".txt")
            self.archive.text(name, transcript(conversation, title, about, document, lambda t: self.resolve(t, name)))
            entry = {"id": conversation["id"], "title": title, "scope": "document" if about else "memory",
                     "document": document["id"] if document else None, "path": name, "startedAt": started,
                     "lastAt": messages[-1].get("createdAt"), "messages": len(messages)}
            self.manifest["chats"].append(entry)
            if document:
                document["chats"].append(name)

    # --- Memory -------------------------------------------------------------

    def lay_out_memory(self) -> list[dict[str, Any]]:
        domains = {d["slug"]: {"slug": d["slug"], "title": d.get("title") or d["slug"], "pages": []}
                   for d in self.storage.memory_domains(self.username)}
        summaries = self.storage.list_memory_pages(self.username, limit=self.settings.memory_max_pages)
        pages = []
        for summary in sorted(summaries, key=lambda s: (s["domain"], s["slug"])):
            page = self.storage.get_memory_page(self.username, summary["slug"])
            domain = domains.setdefault(page["domain"], {"slug": page["domain"], "title": page["domain"], "pages": []})
            entry = {"slug": page["slug"], "title": page["title"], "kind": page["kind"], "summary": page.get("summary"),
                     "updatedAt": page.get("updatedAt"), "path": self.archive.unique(f"memory/{page['domain']}", page["slug"], ".md")}
            domain["pages"].append(entry)
            self.pages[page["slug"]] = entry
            pages.append(page)
        self.manifest["memory"]["domains"] = [d for d in domains.values() if d["pages"]]
        return pages

    def write_page(self, page: dict[str, Any]) -> None:
        here = self.pages[page["slug"]]["path"]
        figures = {}
        for figure in page.get("figures") or []:
            key = figure.get("objectKey")
            if not key:
                continue
            if figure["id"] not in self.figure_files:
                name = f"memory/figures/{figure['id']}{posixpath.splitext(key)[1] or '.webp'}"
                self.figure_files[figure["id"]] = name if self.archive.copy(self.objects, key, name) else None
            if self.figure_files[figure["id"]]:
                figures[figure["id"]] = (self.figure_files[figure["id"]], figure.get("caption") or "")
        body = self.figures(page.get("body") or "", here, figures)
        body = _LINK.sub(lambda m: self.link(m[1].strip(), m[2], here), body)
        head = frontmatter({
            "title": page["title"], "slug": page["slug"], "kind": page["kind"], "domain": page["domain"],
            "summary": page.get("summary"), "tags": page.get("tags"), "aliases": page.get("aliases"),
            "created": page.get("createdAt"), "updated": page.get("updatedAt"),
        })
        self.archive.text(here, head + self.cite(body, page.get("citations") or [], here) + "\n")

    def resolve(self, answer: str, here: str) -> str:
        """An answer's `[[links]]` and plan addresses, as files beside it."""
        plans = {plan["id"]: plan["path"] for plan in self.manifest["plans"]}
        answer = _LINK.sub(lambda m: self.link(m[1].strip(), m[2], here), answer)
        return _PLAN_URL.sub(lambda m: relative(plans[m[1]], here) if m[1] in plans else m[0], answer)

    def link(self, target: str, label: str | None, here: str) -> str:
        page = self.pages.get(target)
        words = (label or "").strip() or (page["title"] if page else target)
        return f"[{words}]({relative(page['path'], here)})" if page else words

    def captured(self, evidence_id: str) -> bool:
        if evidence_id not in self.evidence:
            try:
                record = self.storage.get_external_evidence(self.username, evidence_id)
                self.evidence[evidence_id] = evidence_markdown(record, load_evidence_sections(self.objects, record))
            except (HTTPException, KeyError, ValueError):
                self.evidence[evidence_id] = None
        return self.evidence[evidence_id] is not None

    def write_evidence(self) -> None:
        for evidence_id, text in sorted(self.evidence.items()):
            if text is not None:
                self.archive.text(f"memory/evidence/{evidence_id}.md", text)

    # --- references ---------------------------------------------------------

    def figures(self, body: str, here: str, figures: dict[str, tuple[str, str]]) -> str:
        def embed(match: re.Match[str]) -> str:
            found = figures.get(match[2])
            if not found:
                return f"_[{match[1] or 'A figure that was not captured'}]_"
            name, caption = found
            return f"![{(match[1] or caption).replace(']', '')}]({relative(name, here)})"
        return FIGURE_REF.sub(embed, body)

    def cite(self, body: str, citations: list[dict[str, Any]], here: str) -> str:
        """`[E3]` becomes a footnote naming, and opening, exactly what it cites."""
        known = {int(c["id"]): c for c in citations if str(c.get("id", "")).isdigit()}
        body = MARKER.sub(lambda m: f"[^{m[1]}]" if int(m[1]) in known else m[0], body)
        notes = [f"[^{n}]: {self.locate(known[n], here)}" for n in sorted(known)
                 if f"[^{n}]" in body]
        return body.rstrip() + ("\n\n" + "\n".join(notes) if notes else "")

    def locate(self, citation: dict[str, Any], here: str) -> str:
        kind = citation.get("claimType")
        prefix = f"{CLAIM_LABELS[kind]}: " if kind in CLAIM_LABELS else ""
        if citation.get("evidenceId"):
            if not self.captured(citation["evidenceId"]):
                return f"{prefix}a captured page no longer kept"
            where = f", §{citation['section']}" if citation.get("section") else ""
            return f"{prefix}[captured page{where}]({relative('memory/evidence/' + citation['evidenceId'] + '.md', here)})"
        if citation.get("noteId"):
            document = self.documents.get(self.note_papers.get(citation["noteId"], ""))
            target = document and document["files"].get("annotations")
            return f"{prefix}[{document['title']}, annotations]({relative(target, here)})" if target else f"{prefix}a note since deleted"
        if not citation.get("paperId"):
            return CLAIM_LABELS.get(kind, "uncited")
        document = self.documents.get(citation["paperId"])
        if not document:
            return f"{prefix}a document no longer in the library" + (f", p. {citation['page']}" if citation.get("page") else "")
        files, page, section = document["files"], citation.get("page"), citation.get("section")
        target, anchor, words = f"{document['path']}/document.md", "", ""
        if page:
            words = f", p. {page}"
            if files.get("source"):
                target, anchor = files["source"], f"#page={page}"
        elif section:
            words = f", §{section}"
            if files.get("page"):
                target, anchor = files["page"], f"#{quote_url(str(section))}"
        return f"{prefix}[{document['title']}{words}]({relative(target, here)}{anchor})"

    # --- the rest -----------------------------------------------------------

    def write_personas(self) -> None:
        for summary in self.storage.list_personas(self.username):
            try:
                persona = self.storage.get_persona(self.username, summary["id"])
            except HTTPException:
                continue
            name = self.archive.unique("personas", slug(persona.get("name"), persona["id"]), ".md")
            self.archive.text(name, frontmatter({
                "name": persona.get("name"), "tagline": persona.get("tagline"), "visibility": persona.get("visibility"),
                "created": persona.get("createdAt"), "updated": persona.get("updatedAt"),
            }) + (persona.get("content") or "") + "\n")
            self.manifest["personas"].append({"id": persona["id"], "name": persona.get("name"), "path": name})

    def write_plans(self) -> None:
        state = self.storage.plan_state(self.username)
        for record in sorted((state.get("plans") or {}).values(), key=lambda r: r.get("createdAt") or ""):
            try:
                images = [{**image, "data": base64.b64encode(b"".join(self.objects.open_range(image["key"]))).decode()}
                          for image in record.get("referenceImages") or []]
                conversation = json.loads(self.objects.get_text(record["conversationKey"]))
                page = render_plan(record, images, conversation)
            except (HTTPException, OSError, KeyError, ValueError):
                continue
            title = record["plan"].get("title")
            name = self.archive.unique("plans", slug(title, record["id"]), ".html")
            self.archive.text(name, page)
            self.manifest["plans"].append({"id": record["id"], "title": title, "createdAt": record.get("createdAt"), "path": name})

    def json_object(self, key: str) -> dict[str, Any] | None:
        text = self.text_object(key)
        try:
            return json.loads(text) if text else None
        except ValueError:
            return None

    def text_object(self, key: str) -> str | None:
        try:
            return self.objects.get_text(key) if self.objects.exists(key) else None
        except (HTTPException, OSError, UnicodeDecodeError):
            return None


# --- a conversation, as Claude Code's /export writes one ---------------------


def quote(text: str) -> list[str]:
    return [f"> {line}" if line else ">" for line in text.strip().split("\n")]


def note_lines(note: dict[str, Any]) -> list[str]:
    when = (note.get("updatedAt") or note.get("createdAt") or "")[:10]
    return [f"**Note** ({when}):" if when else "**Note:**", "", note.get("body") or "", ""]


def indent(text: str, first: str, rest: str) -> str:
    lines = text.strip("\n").split("\n")
    return "\n".join([first + lines[0]] + [rest + line if line else "" for line in lines[1:]])


def call(entry: dict[str, Any]) -> str:
    args = ", ".join(f"{key}: {json.dumps(value, ensure_ascii=False)}" for key, value in (entry.get("args") or {}).items())
    head = indent(f"{entry.get('tool')}({args})", "⏺ ", "  ")
    if not entry.get("ok", True):
        return head + "\n" + indent(f"Error: {entry.get('error') or 'the call failed'}", "  ⎿  ", "     ")
    results = entry.get("results") or []
    shown = [" · ".join(str(r[k]) for k in ("title", "url") if r.get(k)) or str(r.get("slug") or r.get("paperId") or "")
             for r in results]
    if entry.get("found") and entry["found"] > len(results):
        shown.append(f"… {entry['found'] - len(results)} more")
    return head + "\n" + indent("\n".join(shown) or "Done", "  ⎿  ", "     ")


def assistant_turn(message: dict[str, Any], resolve: Callable[[str], str] = str) -> list[str]:
    """The answer's text with the work between it, each stretch where it happened."""
    content, blocks, at = message.get("content") or "", [], 0
    for stretch in sorted(message.get("trace") or [], key=lambda s: s.get("offset") or 0):
        offset = max(at, stretch.get("offset") or 0)
        if utf16_slice(content, at, offset).strip():
            blocks.append(indent(resolve(utf16_slice(content, at, offset).strip()), "⏺ ", "  "))
        at = offset
        for entry in stretch.get("entries") or []:
            if entry.get("kind") == "thought" and (entry.get("text") or "").strip():
                blocks.append(indent(entry["text"], "✻ Thinking… ", "  "))
            elif entry.get("kind") == "tool":
                blocks.append(call(entry))
    if utf16_slice(content, at).strip():
        blocks.append(indent(resolve(utf16_slice(content, at).strip()), "⏺ ", "  "))
    if message.get("sources"):
        blocks.append(indent("\n".join(" · ".join(x for x in (s.get("title"), s.get("url")) if x)
                                       for s in message["sources"]), "  ⎿  Sources: ", "              "))
    if message.get("cancelled"):
        blocks.append("  ⎿  Stopped before the answer was finished")
    if message.get("error"):
        blocks.append(indent(f"Error: {message['error']}", "  ⎿  ", "     "))
    return blocks


def transcript(conversation: dict[str, Any], title: str, about: bool, document: dict[str, Any] | None,
               resolve: Callable[[str], str] = str) -> str:
    scope = "Memory chat" if not about else f"Document chat · {document['title'] if document else 'a deleted document'}"
    started = (conversation.get("createdAt") or "")[:16].replace("T", " ")
    blocks = [f"✻ Delphi · {title}\n  {scope}" + (f"\n  Started {started} UTC" if started else "")]
    for message in conversation.get("messages") or []:
        if message.get("role") == "user":
            text = message.get("content") or ""
            if message.get("selectedText"):
                text = "\n".join(f"│ {line}" for line in message["selectedText"].strip().split("\n")) + "\n\n" + text
            blocks.append(indent(text or "(no text)", "> ", "  "))
        else:
            blocks += assistant_turn(message, resolve)
    return "\n\n".join(blocks) + "\n"


# --- what the folder says about itself ---------------------------------------


README = """# Your Delphi library

Everything you added, read, wrote and asked in Delphi, as plain files.
Nothing here needs Delphi to open. Open `index.html` in a browser for an
overview with links to every file; `manifest.json` lists the same thing for a
program. Paths below are relative to this folder.

## Layout

```
index.html                     an overview of everything, opens from disk
manifest.json                  every project, document, page, chat, persona and plan, with its path
library/<project>/<document>/
  document.md                  the document's details, then Delphi's digest of it
  source.pdf                   the PDF you added (PDF documents)
  page.html                    the saved copy of the web page (web documents)
  text.md                      the document's text as Delphi read it; PDF pages
                               are marked `--- Page N ---`
  annotations.md               your highlights, each with the notes you wrote on it
  annotations.json             the same, with exact positions (PDF rectangles
                               normalised 0..1 to the page; HTML text anchors)
  assets/                      the figures the digest shows
  chats/<date>-<title>.txt     your conversations about this document
memory/<domain>/<page>.md      the Memory wiki, one file per page, by domain
memory/figures/                figures Memory pages show
memory/evidence/               pages from outside your library that Memory cites,
                               as Delphi captured them
chats/<date>-<title>.txt       Memory conversations, not tied to one document
personas/<name>.md             the personas you wrote or installed
plans/<title>.html             your research plans, each a self-contained page
```

## Conventions

- Markdown files start with YAML front matter (`title`, `kind`, dates, ...).
  Dates are ISO 8601 in UTC.
- Links between files are ordinary relative Markdown links.
- A claim's citation is a footnote (`[^3]`) that names the source and links to
  it: the cited page of the PDF (`source.pdf#page=19`), a section of a saved
  web page, your annotations, or a captured outside page. "inference" marks a
  claim Delphi drew rather than found; "your note" one that rests on a note.
- Memory pages come in three kinds: `source` (one document, written from its
  digest), `concept` (an idea across documents) and `domain` (an overview of a
  domain's pages).
- A chat file reads top to bottom as the conversation happened: `>` is you,
  `⏺` is Delphi's answer or a tool call it made (`⎿` is what came back),
  `✻ Thinking…` is a summary of its reasoning, and `│` a passage you
  selected to ask about.

This is a copy. Editing these files changes nothing in Delphi.
"""


def index_html(manifest: dict[str, Any]) -> str:
    # `</` is the only sequence that can end a script element early; a title
    # holding it must stay data.
    data = json.dumps(manifest, ensure_ascii=False).replace("</", "<\\/")
    return INDEX.replace("__DATA__", data)


INDEX = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delphi library</title>
<style>
:root { --bg: #faf9f6; --panel: #fff; --text: #1d1b18; --muted: #6f6a62; --line: #e4e0d8; --accent: #3a5fae; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #171614; --panel: #201f1c; --text: #ece8e1; --muted: #9c968c; --line: #34312c; --accent: #8fb0ef; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 36px 0 10px; }
h3 { font-size: 15px; margin: 20px 0 6px; color: var(--muted); font-weight: 600; }
.meta, .muted { color: var(--muted); font-size: 13px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
input { width: 100%; margin: 20px 0 0; padding: 10px 12px; font: inherit; color: inherit; background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px; }
nav { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 12px; font-size: 14px; }
.list { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
.row { padding: 10px 14px; border-top: 1px solid var(--line); }
.row:first-child { border-top: 0; }
.row .title { font-weight: 600; overflow-wrap: anywhere; }
.links { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 13px; margin-top: 2px; }
.empty { padding: 10px 14px; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<main>
<h1>Delphi library</h1>
<div class="meta" id="meta"></div>
<nav id="nav"></nav>
<input id="filter" type="search" placeholder="Filter by title" aria-label="Filter by title">
<div id="sections"></div>
</main>
<script id="data" type="application/json">__DATA__</script>
<script>
(function () {
  "use strict";
  var data = JSON.parse(document.getElementById("data").textContent);
  var root = document.getElementById("sections");
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function link(label, path) {
    var a = el("a", null, label);
    a.href = path.split("/").map(encodeURIComponent).join("/");
    return a;
  }
  function day(iso) { return iso ? String(iso).slice(0, 10) : ""; }
  function row(title, href, meta, links) {
    var r = el("div", "row");
    r.dataset.search = (title || "").toLowerCase();
    var t = el("div", "title");
    t.appendChild(href ? link(title || "Untitled", href) : document.createTextNode(title || "Untitled"));
    r.appendChild(t);
    if (meta) r.appendChild(el("div", "muted", meta));
    if (links && links.length) {
      var l = el("div", "links");
      links.forEach(function (pair) { l.appendChild(link(pair[0], pair[1])); });
      r.appendChild(l);
    }
    return r;
  }
  function section(id, title, count) {
    var s = el("section");
    s.id = id;
    s.appendChild(el("h2", null, title + " (" + count + ")"));
    root.appendChild(s);
    var a = link(title, "");
    a.href = "#" + id;
    document.getElementById("nav").appendChild(a);
    return s;
  }
  function list(parent, rows) {
    var box = el("div", "list");
    if (!rows.length) box.appendChild(el("div", "empty muted", "Nothing here."));
    rows.forEach(function (r) { box.appendChild(r); });
    parent.appendChild(box);
  }

  var documents = 0, pages = 0;
  data.projects.forEach(function (p) { documents += p.documents.length; });
  data.memory.domains.forEach(function (d) { pages += d.pages.length; });
  document.getElementById("meta").textContent = "Exported " + day(data.exportedAt) + " · " + documents + " documents · "
    + pages + " Memory pages · " + data.chats.length + " chats. See README.md for what each file is.";

  var library = section("library", "Library", documents);
  data.projects.forEach(function (p) {
    library.appendChild(el("h3", null, p.name || "Untitled project"));
    list(library, p.documents.map(function (d) {
      var f = d.files, links = [];
      if (f.source) links.push(["PDF", f.source]);
      if (f.page) links.push(["Saved page", f.page]);
      if (f.text) links.push(["Text", f.text]);
      if (f.annotations) links.push(["Annotations (" + d.highlights + ")", f.annotations]);
      d.chats.forEach(function (c, i) { links.push(["Chat " + (i + 1), c]); });
      var meta = [d.kind === "web" ? "Web page" : "PDF", d.kind !== "web" && d.pages ? d.pages + " pages" : "", "added " + day(d.addedAt),
        d.readAt ? "read " + day(d.readAt) : "", d.url || ""].filter(Boolean).join(" · ");
      return row(d.title, f.document, meta, links);
    }));
  });

  var memory = section("memory", "Memory", pages);
  data.memory.domains.forEach(function (d) {
    memory.appendChild(el("h3", null, d.title));
    list(memory, d.pages.map(function (p) {
      return row(p.title, p.path, p.kind + (p.summary ? " · " + p.summary : ""));
    }));
  });

  var chats = section("chats", "Chats", data.chats.length);
  var titles = {};
  data.projects.forEach(function (p) { p.documents.forEach(function (d) { titles[d.id] = d.title; }); });
  list(chats, data.chats.slice().reverse().map(function (c) {
    var scope = c.document ? "About " + (titles[c.document] || "a document") : "Memory chat";
    return row(c.title, c.path, [day(c.lastAt || c.startedAt), scope, c.messages + " messages"].join(" · "));
  }));

  if (data.personas.length) {
    list(section("personas", "Personas", data.personas.length), data.personas.map(function (p) { return row(p.name, p.path); }));
  }
  if (data.plans.length) {
    list(section("plans", "Plans", data.plans.length), data.plans.map(function (p) { return row(p.title, p.path, day(p.createdAt)); }));
  }

  document.getElementById("filter").addEventListener("input", function (event) {
    var q = event.target.value.trim().toLowerCase();
    Array.prototype.forEach.call(document.querySelectorAll(".row"), function (r) {
      r.hidden = q !== "" && r.dataset.search.indexOf(q) === -1;
    });
  });
})();
</script>
</body>
</html>
"""
