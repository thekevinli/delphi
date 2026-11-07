"""
The retirement of three page kinds and two claim types, on the local store.

A local store runs the retirement rules the first time `LocalStorage` opens an
account written before them (`delphi_core/storage/local_format.py`); a SQL
store runs the same rules as Alembic revision `b7d2f4a6c931`, and the suite
that holds that revision holds the two to one seed and one expected outcome.
Here, the seed is written in the shape an earlier release left.
"""

import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from delphi_core.config import Settings
from delphi_core.storage import LocalStorage, local_format

THEN = "2026-09-01T00:00:00+00:00"

MEMBERS = (
    "<!-- delphi-members:start -->\n## Pages in this domain\n\n"
    "- [[kl-divergence]] — **KL divergence** — A distance.\n"
    "- [[missing-idea]] — **Missing idea**\n<!-- delphi-members:end -->"
)


def cite(number, claim, paper=None, page=None, **more):
    return {"id": number, "claimType": claim, "paperId": paper, "page": page, "section": None,
            "noteId": None, "evidenceId": None, **more}


def page(slug, kind, title, body, *, domain="stats", citations=(), revision=1, **more):
    return {"id": f"id-{slug}", "slug": slug, "kind": kind, "domain": domain, "title": title,
            "summary": f"About {title}.", "body": body, "tags": [], "citations": list(citations),
            "revision": revision, "createdAt": THEN, "updatedAt": THEN, **more}


#: Two accounts as an earlier release left them. `other` holds a page at a
#: slug `reader` also has, so a title can only come from the right account.
SEED = {
    "reader": {
        "pages": [
            page("kl-divergence", "concept", "KL divergence",
                 "Compare [[missing-idea]] and [[Missing Idea|the hole]]. See [[open-question]], the "
                 "[[field-synthesis|synthesis]], [[ml]] and [[stats]].\n\n```\n[[missing-idea]] in code\n```\n\n"
                 "Inline `[[open-question]]` too. Never written: [[never-written]]. [E1][E2][E3]",
                 citations=[cite(1, "author-claim", "p1", 3), cite(2, "reader-inference", "p1", 4),
                            cite(3, "conversation")],
                 revision=4),
            page("missing-idea", "gap", "Missing idea", "Named by [[kl-divergence]], never explained."),
            page("open-question", "question", "What is open?", "Whether [[kl-divergence]] is symmetric."),
            page("field-synthesis", "synthesis", "The field so far", "Ties [[kl-divergence]] to [[paper-one]]."),
            page("ml", "domain", "Machine learning",
                 "Hub for the reader's Machine learning concepts, sources, and open questions.\n\n"
                 "Pages filed under this area:\n\n- [[paper-one]] — Paper one", domain="ml"),
            page("empty-area", "domain", "Empty area",
                 "Hub for the reader's Empty area concepts, sources, and open questions.", domain="empty-area"),
            page("only-members", "domain", "Only members", MEMBERS, domain="only-members"),
            page("stats", "domain", "Statistics",
                 "Statistics for this reader: start at [[kl-divergence]], then the [[missing-idea]].\n\n" + MEMBERS,
                 revision=2),
            page("paper-one", "source", "Paper one", "The digest [E1] [E2]. Filed under [[ml]].", domain="ml",
                 citations=[cite(1, "author-claim", "p1", 2), cite(2, "reader-inference", "p1", 7)],
                 sourcePaperId="p1", sourceProjectId="proj"),
            page("untouched", "concept", "Untouched", "Rests on [[kl-divergence]] [E1].",
                 citations=[cite(1, "author-claim", "p1", 1)], revision=3),
        ],
        "figures": [("f-gap", "missing-idea"), ("f-source", "paper-one")],
        "versions": [
            ("kl-divergence", 4, "ev-1", "conversation", [cite(1, "author-claim", "p1", 3), cite(3, "conversation")]),
            ("untouched", 3, "ev-2", "document", [cite(1, "author-claim", "p1", 1)]),
            ("ml", 1, None, None, []),
        ],
        "events": 2,
        "jobs": [("page-rewrite", "rewrite:missing-idea", {"pageSlug": "missing-idea"}),
                 ("page-rewrite", "rewrite:untouched", {"pageSlug": "untouched"}),
                 ("document", "paper:p1", {"paperId": "p1", "projectId": "proj"})],
        "conversations": [("a" * 32, ["r1", "r2"], "r1"), ("b" * 32, [], None)],
    },
    "other": {
        "pages": [
            page("kl-divergence", "concept", "KL", "Their [[missing-idea]]."),
            page("missing-idea", "gap", "Their hole", "Open."),
        ],
        "figures": [], "versions": [], "events": 1, "jobs": [], "conversations": [("c" * 32, ["q9"], None)],
    },
}

KL_BODY = (
    "Compare Missing idea and the hole. See What is open?, the synthesis, Machine learning and [[stats]].\n\n"
    "```\n[[missing-idea]] in code\n```\n\n"
    "Inline `[[open-question]]` too. Never written: [[never-written]]. [E1][E2][E3]"
)

#: What the store holds afterwards. A page is (kind, body, revision) with its
#: citations as (id, claim type, paper, page); a version is (revision, note,
#: event id, claim types).
EXPECTED = {
    "reader": {
        "pages": {
            "kl-divergence": ("concept", KL_BODY, 5,
                              [(1, "author-claim", "p1", 3), (2, "derived", None, None), (3, "derived", None, None)]),
            "stats": ("domain", "Statistics for this reader: start at [[kl-divergence]], then the Missing idea.", 3, []),
            "paper-one": ("source", "The digest [E1] [E2]. Filed under Machine learning.", 2,
                          [(1, "author-claim", "p1", 2), (2, "derived", None, None)]),
            "untouched": ("concept", "Rests on [[kl-divergence]] [E1].", 3, [(1, "author-claim", "p1", 1)]),
        },
        # The stores read a link inside code as an edge too, so those two stay.
        "links": {"kl-divergence": ["missing-idea", "never-written", "open-question", "stats"],
                  "stats": ["kl-divergence"], "paper-one": [], "untouched": ["kl-divergence"]},
        "figures": ["f-source"],
        "versions": {
            "kl-divergence": [(5, local_format.RETIREMENT_NOTE, None, ["author-claim", "derived", "derived"]),
                              (4, None, None, ["author-claim", "derived"])],
            "stats": [(3, local_format.RETIREMENT_NOTE, None, [])],
            "untouched": [(3, None, None, ["author-claim"])],
        },
        "events": 0,
        "jobs": [("document", "paper:p1"), ("page-rewrite", "rewrite:untouched")],
        "watermarks": {"a" * 32: "r2", "b" * 32: None},
    },
    "other": {
        "pages": {"kl-divergence": ("concept", "Their Their hole.", 2, [])},
        "links": {"kl-divergence": []},
        "figures": [],
        "versions": {"kl-divergence": [(2, local_format.RETIREMENT_NOTE, None, [])]},
        "events": 0,
        "jobs": [],
        "watermarks": {"c" * 32: "q9"},
    },
}


def figure_key(owner, figure_id):
    return f"knowledge/u/{owner}/figures/{figure_id}.webp"


# --- the local store ---------------------------------------------------------


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def seed_local(root):
    """The files a release before the format marker left on disk."""
    for owner, held in SEED.items():
        user = root / "users" / owner
        write(user / "account.json", {"username": owner, "passwordSalt": "s", "passwordHash": "h", "createdAt": THEN})
        knowledge = user / "knowledge"
        for record in held["pages"]:
            # A record of that release also carried the reader's level.
            write(knowledge / "pages" / f"{record['slug']}.json",
                  {**record, "links": local_format.links_of(record["body"]), "level": "learning",
                   "observations": [], "lastSeenAt": THEN, "encounters": 2})
        figures = []
        for figure_id, slug in held["figures"]:
            figures.append({"id": figure_id, "pageId": f"id-{slug}", "caption": "A figure", "captured": True,
                            "objectKey": figure_key(owner, figure_id), "createdAt": THEN})
            stored = knowledge / "figures" / f"{figure_id}.webp"
            stored.parent.mkdir(parents=True, exist_ok=True)
            stored.write_bytes(b"webp")
        write(knowledge / "figures.json", figures)
        by_slug = {record["slug"]: record for record in held["pages"]}
        for slug, revision, event_id, trigger, citations in held["versions"]:
            write(knowledge / "versions" / slug / f"{revision:08d}.json",
                  {"slug": slug, "revision": revision, "title": by_slug[slug]["title"], "summary": "",
                   "body": by_slug[slug]["body"], "citations": citations, "createdAt": THEN,
                   "eventId": event_id, "trigger": trigger, "note": None})
        write(knowledge / "events.json",
              [{"id": f"ev-{n}", "kind": "paper-added", "requestId": f"paper-added:p{n}", "createdAt": THEN,
                "version": "knowledge-v5", "pages": ["missing-idea"]} for n in range(1, held["events"] + 1)])
        jobs = [{"id": f"job-{n}", "kind": kind, "marker": marker, "status": "pending", "payload": payload,
                 "attempts": 0, "createdAt": THEN, "updatedAt": THEN}
                for n, (kind, marker, payload) in enumerate(held["jobs"])]
        # A local queue could still hold work of a kind no worker claims.
        jobs.append({"id": "job-old", "kind": "answer", "marker": "answer:r1", "status": "pending", "payload": {},
                     "attempts": 0, "createdAt": THEN, "updatedAt": THEN})
        write(knowledge / "jobs.json", jobs)
        write(knowledge / "graph.json", {"revision": 7})
        for conversation_id, requests, _ in held["conversations"]:
            messages = [{"role": role, "content": "…", "requestId": request, "createdAt": THEN}
                        for request in requests for role in ("user", "assistant")]
            # No watermark key at all: the field is newer than these files.
            write(user / "conversations" / f"{conversation_id}.json",
                  {"id": conversation_id, "kind": "knowledge_base_chat", "projectId": None, "paperId": None,
                   "title": "A chat", "createdAt": THEN, "lastEngagedAt": THEN, "messages": messages,
                   "generation": 0, "threadKey": f"conversation-{conversation_id}-0"})


def cited(citations):
    return [(row["id"], row["claimType"], row["paperId"], row["page"]) for row in citations or ()]


def local_outcome(root):
    """What a store holds, read through `LocalStorage` and from its files."""
    storage = LocalStorage(Settings(data_dir=root))
    outcome = {}
    for owner in SEED:
        # Opened, the store is at format 5, which renamed the directory.
        memory = root / "users" / owner / "memory"
        pages = {row["slug"]: storage.get_memory_page(owner, row["slug"])
                 for row in storage.list_memory_pages(owner, limit=50)}
        outcome[owner] = {
            "pages": {slug: (held["kind"], held["body"], held["revision"], cited(held["citations"]))
                      for slug, held in pages.items()},
            "links": {slug: sorted(held["links"]) for slug, held in pages.items()},
            "figures": sorted(row["id"] for row in storage.list_memory_figures(owner)),
            "versions": {
                directory.name: [(row["revision"], row["note"], row["eventId"],
                                  [item["claimType"] for item in row["citations"]])
                                 for row in storage.list_page_versions(owner, directory.name)]
                for directory in sorted((memory / "versions").iterdir())
            } if (memory / "versions").is_dir() else {},
            "events": len(storage.list_memory_events(owner, limit=50)),
            "jobs": sorted((job["kind"], job["marker"]) for job in storage.list_memory_jobs(owner)),
            "watermarks": {conversation_id: storage.get_conversation(owner, conversation_id)["memoryFiledThrough"]
                           for conversation_id, _, _ in SEED[owner]["conversations"]},
        }
    return outcome


def marker(root, owner="reader"):
    """The account's marker: in `memory/` once format 5 renamed the directory, in `knowledge/` while a step before it runs."""
    user = root / "users" / owner
    renamed = user / "memory" / "format.json"
    return json.loads((renamed if renamed.exists() else user / "knowledge" / "format.json").read_text())


def files(root):
    return {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in sorted(root.rglob("*")) if path.is_file()}


def test_an_older_local_store_is_retired_the_first_time_it_is_opened(tmp_path):
    seed_local(tmp_path)

    assert local_outcome(tmp_path) == EXPECTED

    for owner in SEED:
        assert marker(tmp_path, owner) == {"format": local_format.LOCAL_FORMAT}
        memory = tmp_path / "users" / owner / "memory"
        assert sorted(path.stem for path in (memory / "pages").iterdir()) == sorted(EXPECTED[owner]["pages"])
    memory = tmp_path / "users" / "reader" / "memory"
    # A deleted page's figure goes with its bytes; a kept page's stays.
    assert sorted(path.name for path in (memory / "figures").iterdir()) == ["f-source.webp"]
    assert json.loads((memory / "graph.json").read_text())["revision"] > 7
    for path in (memory / "pages").iterdir():
        record = json.loads(path.read_text())
        assert not set(record) & set(local_format.RETIRED_PAGE_FIELDS)
    # A page nothing changed on keeps its revision and its date.
    untouched = json.loads((memory / "pages" / "untouched.json").read_text())
    assert (untouched["revision"], untouched["updatedAt"]) == (3, THEN)


def test_what_an_account_held_before_the_retirement_is_kept_beside_it(tmp_path):
    seed_local(tmp_path)
    before = {
        path.relative_to(tmp_path).as_posix(): path.read_bytes()
        for path in (tmp_path / "users" / "reader" / "knowledge").rglob("*") if path.is_file()
    }
    assert before

    local_outcome(tmp_path)

    kept = tmp_path / "users" / "reader" / local_format.BEFORE_RETIREMENT
    # Every file as it was, the deleted pages and the cleared log among them.
    assert {
        f"users/reader/knowledge/{path.relative_to(kept).as_posix()}": path.read_bytes()
        for path in kept.rglob("*") if path.is_file()
    } == before
    # Taken once: a later open does not copy the retired store over it.
    stamp = sorted((path.name, path.stat().st_mtime_ns) for path in kept.rglob("*"))
    local_outcome(tmp_path)
    assert sorted((path.name, path.stat().st_mtime_ns) for path in kept.rglob("*")) == stamp


def test_a_second_open_of_a_retired_store_changes_nothing(tmp_path):
    seed_local(tmp_path)
    LocalStorage(Settings(data_dir=tmp_path))
    before = files(tmp_path)

    # A new process knows nothing of the first open: it reads each marker.
    local_format._CURRENT.clear()
    storage = LocalStorage(Settings(data_dir=tmp_path))
    LocalStorage(Settings(data_dir=tmp_path))

    assert files(tmp_path) == before
    # What is written afterwards stays: the step never runs on this store again.
    storage.append_memory_event("reader", {"kind": "document", "requestId": "paper:p1"})
    storage.upsert_memory_page(
        "reader", {"slug": "ml", "kind": "domain", "domain": "ml", "title": "Machine learning",
                   "body": "Hub for the reader's Machine learning concepts.\n\nPages filed under this area:\n"},
        max_pages=50)
    local_format._CURRENT.clear()
    reopened = LocalStorage(Settings(data_dir=tmp_path))
    assert len(reopened.list_memory_events("reader", limit=50)) == 1
    assert reopened.get_memory_page("reader", "ml")["kind"] == "domain"


@pytest.mark.parametrize("survives", ["the plan", "the pages that stay", "the deleted pages", "the event log", "the queue"])
def test_an_interrupted_retirement_finishes_on_the_next_open(tmp_path, monkeypatch, survives):
    """
    A crash at each point of the step, then an ordinary open.

    The marker is written last, so a store that did not finish is still
    behind; and what it will delete is written first, so a link to a page
    whose file is already gone is still repaired to that page's title.
    """
    seed_local(tmp_path)
    knowledge = tmp_path / "users" / "reader" / "knowledge"
    crash_before = {
        "the plan": knowledge / "pages" / "kl-divergence.json",
        "the pages that stay": knowledge / "figures.json",
        "the deleted pages": knowledge / "events.json",
        "the event log": knowledge / "jobs.json",
        "the queue": knowledge / "graph.json",
    }[survives]
    real = LocalStorage._write_json

    def crashing(self, path, value):
        if path == crash_before:
            raise OSError("the process died")
        real(self, path, value)

    monkeypatch.setattr(LocalStorage, "_write_json", crashing)
    with pytest.raises(OSError):
        LocalStorage(Settings(data_dir=tmp_path))
    assert marker(tmp_path)["format"] == 1 and "missing-idea" in marker(tmp_path)["retiring"]
    if survives in ("the deleted pages", "the event log", "the queue"):
        assert not (knowledge / "pages" / "missing-idea.json").exists()
    monkeypatch.setattr(LocalStorage, "_write_json", real)

    outcome = local_outcome(tmp_path)

    # A page the first run already rewrote is not rewritten again.
    assert outcome == EXPECTED
    assert marker(tmp_path) == {"format": local_format.LOCAL_FORMAT}


def test_a_new_store_and_a_new_account_are_never_retired(tmp_path, monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the retirement ran on a store that was never behind")

    monkeypatch.setattr(local_format, "_retire", refuse)
    storage = LocalStorage(Settings(data_dir=tmp_path))
    assert not (tmp_path / "users").exists()

    storage.create_account("reader", None, "salt", "hash")
    assert marker(tmp_path) == {"format": local_format.LOCAL_FORMAT}
    storage.upsert_memory_page(
        "reader", {"slug": "idea", "kind": "concept", "domain": "ml", "title": "Idea", "body": "An idea."}, max_pages=50)
    storage.append_memory_event("reader", {"kind": "document", "requestId": "paper:p1"})
    local_format._CURRENT.clear()
    reopened = LocalStorage(Settings(data_dir=tmp_path))

    assert reopened.get_memory_page("reader", "idea")["revision"] == 1
    assert len(reopened.list_memory_events("reader", limit=50)) == 1


def test_an_account_at_the_current_format_is_read_once_in_a_process(tmp_path, monkeypatch):
    storage = LocalStorage(Settings(data_dir=tmp_path))
    storage.create_account("reader", None, "salt", "hash")
    LocalStorage(Settings(data_dir=tmp_path))
    reads = []
    real = local_format._read
    monkeypatch.setattr(local_format, "_read", lambda path, default: reads.append(path) or real(path, default))

    for _ in range(3):
        LocalStorage(Settings(data_dir=tmp_path))

    assert reads == []
    # An account that appears later is still seen.
    storage.create_account("second", None, "salt", "hash")
    LocalStorage(Settings(data_dir=tmp_path))
    LocalStorage(Settings(data_dir=tmp_path))
    assert [path.parent.parent.name for path in reads] == ["second"]


def test_a_retired_store_refuses_what_it_retired(tmp_path):
    seed_local(tmp_path)
    storage = LocalStorage(Settings(data_dir=tmp_path))

    for kind in ("gap", "question", "synthesis"):
        with pytest.raises(HTTPException) as refused:
            storage.upsert_memory_page(
                "reader", {"slug": "again", "kind": kind, "domain": "ml", "title": "Again", "body": "Open."},
                max_pages=50)
        assert refused.value.status_code == 422
    kinds = {row["kind"] for row in storage.list_memory_pages("reader", limit=50)}
    claims = {item["claimType"] for row in storage.list_memory_pages("reader", limit=50)
              for item in storage.get_memory_page("reader", row["slug"])["citations"]}
    assert kinds <= {"source", "concept", "domain"}
    assert claims <= {"author-claim", "external", "reader-note", "derived"}


# --- the rules ---------------------------------------------------------------


def test_a_stub_domain_page_is_told_from_a_composed_one():
    stub = local_format.is_stub
    composed = "Three clusters: inference ([[elbo]]), divergences ([[kl-divergence]]) and sampling."
    hub = "Hub for the reader's ML concepts, sources, and open questions."

    assert stub({"kind": "domain", "body": hub, "citations": []})
    assert stub({"kind": "domain", "body": hub + "\n\nPages filed under this area:\n\n- [[elbo]] — ELBO"})
    assert stub({"kind": "domain", "body": MEMBERS, "citations": [cite(1, "derived")]})
    assert stub({"kind": "domain", "body": ""})
    assert not stub({"kind": "domain", "body": composed})
    assert not stub({"kind": "domain", "body": composed + "\n\n" + MEMBERS})
    # Cited, or opening with the stub's words and then going on to link: composed.
    assert not stub({"kind": "domain", "body": hub + " Pages filed under this area", "citations": [cite(1, "derived")]})
    assert not stub({"kind": "domain", "body": hub + " Start at [[elbo]]."})
    assert not stub({"kind": "concept", "body": hub})


def test_the_membership_block_is_taken_out_and_the_prose_is_left():
    strip = local_format.without_membership

    assert strip("Framing.\n\n" + MEMBERS) == "Framing."
    assert strip("Framing.\n\n" + MEMBERS + "\n\nAfter.") == "Framing.\n\nAfter."
    # A body without the block is returned as written, spacing and all.
    assert strip("  Framing.\n\n\n\nMore.  ") == "  Framing.\n\n\n\nMore.  "


def test_the_rules_slug_a_link_as_the_stores_do():
    from delphi_core.storage.base import memory_slug, parse_wiki_links

    for name in ("KL Divergence", "Rényi's α", "!!!", "a" * 90, "Missing Idea", "x--y"):
        assert local_format.slug_of(name) == memory_slug(name)
    body = "See [[Variational Inference]], [[variational inference]] and [[ELBO|the bound]]."
    assert local_format.links_of(body) == parse_wiki_links(body)


def test_a_link_to_a_deleted_page_is_repaired_as_a_delete_repairs_it():
    from delphi_core.storage.base import unlink_deleted_page

    body = "A [[gone]] and [[Gone|its label]], `[[gone]]` in code, and [[kept]]."
    assert local_format.unlinked(body, {"gone": "The gone page"}) == unlink_deleted_page(body, "gone", "The gone page")


# --- format 3: the stubs a store regrew ---------------------------------------

STUB = "Hub for the reader's Stats concepts, sources, and open questions.\n\nPages filed under this area:\n\n- [[elbo]] — ELBO"
#: An account at format 2, as the release that wrote it left one: its stub is
#: back, and a composed page has the list of members appended again.
REGROWN = [
    page("stats", "domain", "Stats", STUB),
    page("ml", "domain", "Machine learning", "How the ideas fit. [E1]\n\n" + MEMBERS, domain="ml",
         citations=[cite(1, "derived")], revision=4),
    page("elbo", "concept", "ELBO", "A bound. See [[stats]], [[Stats|the field]] and [[ml]]. `[[stats]]`", revision=2),
    page("quiet", "concept", "Quiet", "Nothing here links to a domain.", revision=5),
]
AFTER_STUBS = {
    "pages": {
        "ml": ("domain", "How the ideas fit. [E1]", 5, [(1, "derived", None, None)]),
        "elbo": ("concept", "A bound. See Stats, the field and [[ml]]. `[[stats]]`", 3, []),
        "quiet": ("concept", "Nothing here links to a domain.", 5, []),
    },
    # A link inside code is left as written, and the link index still reads it as one.
    "links": {"ml": [], "elbo": ["ml", "stats"], "quiet": []},
    "notes": {"ml": local_format.STUB_CLEANUP_NOTE, "elbo": local_format.STUB_CLEANUP_NOTE},
    "events": 2,
    "jobs": [("domain", "domain:stats")],
}


def seed_format_two(root):
    user = root / "users" / "reader"
    write(user / "account.json", {"username": "reader", "passwordSalt": "s", "passwordHash": "h", "createdAt": THEN})
    knowledge = user / "knowledge"
    for record in REGROWN:
        write(knowledge / "pages" / f"{record['slug']}.json", {**record, "links": local_format.links_of(record["body"])})
    write(knowledge / "versions" / "stats" / "00000001.json", {
        "slug": "stats", "revision": 1, "title": "Stats", "summary": "", "body": STUB, "citations": [],
        "createdAt": THEN, "eventId": None, "trigger": None, "note": None})
    write(knowledge / "versions" / "elbo" / "00000002.json", {
        "slug": "elbo", "revision": 2, "title": "ELBO", "summary": "", "body": "A bound.", "citations": [],
        "createdAt": THEN, "eventId": "ev-1", "trigger": "document", "note": "wrote it"})
    write(knowledge / "events.json", [{"id": f"ev-{n}", "kind": "document", "requestId": f"paper:p{n}", "createdAt": THEN} for n in (1, 2)])
    write(knowledge / "jobs.json", [{"id": "job-1", "kind": "domain", "marker": "domain:stats", "status": "pending",
                                     "payload": {"domain": "stats"}, "attempts": 0, "createdAt": THEN, "updatedAt": THEN}])
    write(knowledge / "figures.json", [])
    write(knowledge / "graph.json", {"revision": 7})
    write(knowledge / "format.json", {"format": 2})


def stub_outcome(root):
    storage = LocalStorage(Settings(data_dir=root))
    pages = {row["slug"]: storage.get_memory_page("reader", row["slug"]) for row in storage.list_memory_pages("reader", limit=50)}
    return {
        "pages": {slug: (held["kind"], held["body"], held["revision"], cited(held["citations"])) for slug, held in pages.items()},
        "links": {slug: sorted(held["links"]) for slug, held in pages.items()},
        "notes": {slug: rows[0]["note"] for slug in pages
                  if (rows := storage.list_page_versions("reader", slug)) and rows[0]["revision"] == pages[slug]["revision"]
                  and rows[0]["note"] != "wrote it"},
        "events": len(storage.list_memory_events("reader", limit=50)),
        "jobs": sorted((job["kind"], job["marker"]) for job in storage.list_memory_jobs("reader")),
    }


def test_a_format_two_store_loses_the_stubs_it_regrew_and_nothing_else(tmp_path):
    seed_format_two(tmp_path)
    before = {path.name: path.read_bytes() for path in (tmp_path / "users/reader/knowledge/pages").iterdir()}

    assert stub_outcome(tmp_path) == AFTER_STUBS

    assert marker(tmp_path) == {"format": local_format.LOCAL_FORMAT}
    memory = tmp_path / "users" / "reader" / "memory"
    assert (memory / "versions").is_dir() and not (memory / "versions" / "stats").exists()
    assert json.loads((memory / "graph.json").read_text())["revision"] == 8
    # The log is not cleared by this step, so a version row goes on naming its event.
    assert json.loads((memory / "versions" / "elbo" / "00000002.json").read_text())["eventId"] == "ev-1"
    # Only the page files the step deleted or rewrote are kept, as they were, and no whole copy is taken.
    kept = tmp_path / "users" / "reader" / local_format.BEFORE_STUB_CLEANUP
    assert {path.relative_to(kept).as_posix(): path.read_bytes() for path in kept.rglob("*") if path.is_file()} == {
        f"pages/{name}": before[name] for name in ("stats.json", "ml.json", "elbo.json")}
    assert not (tmp_path / "users" / "reader" / local_format.BEFORE_RETIREMENT).exists()

    # A second open, as a new process, changes nothing.
    held = files(tmp_path)
    local_format._CURRENT.clear()
    LocalStorage(Settings(data_dir=tmp_path))
    assert files(tmp_path) == held


def test_a_store_with_no_stub_is_marked_and_keeps_no_copy(tmp_path):
    seed_format_two(tmp_path)
    pages = tmp_path / "users" / "reader" / "knowledge" / "pages"
    for name in ("stats", "ml", "elbo"):
        (pages / f"{name}.json").unlink()
    quiet = (pages / "quiet.json").read_bytes()

    LocalStorage(Settings(data_dir=tmp_path))

    renamed = tmp_path / "users" / "reader" / "memory" / "pages"
    assert marker(tmp_path) == {"format": local_format.LOCAL_FORMAT} and (renamed / "quiet.json").read_bytes() == quiet
    assert not (tmp_path / "users" / "reader" / local_format.BEFORE_STUB_CLEANUP).exists()


@pytest.mark.parametrize("survives", ["the copy", "the plan", "the pages that stay", "the deleted pages"])
def test_an_interrupted_stub_cleanup_finishes_on_the_next_open(tmp_path, monkeypatch, survives):
    """The plan is written before anything is deleted, and the marker last, as for the step before it."""
    seed_format_two(tmp_path)
    knowledge = tmp_path / "users" / "reader" / "knowledge"
    real_write, real_copy = LocalStorage._write_json, local_format.shutil.copy2
    crash_before = {
        "the plan": knowledge / "pages" / "elbo.json",
        "the pages that stay": knowledge / "figures.json",
        "the deleted pages": knowledge / "graph.json",
    }.get(survives)

    def crashing(self, path, value):
        if path == crash_before or (survives == "the pages that stay" and path == knowledge / "pages" / "ml.json"):
            raise OSError("the process died")
        real_write(self, path, value)

    def cut_short(source, target):
        if Path(source).name == "ml.json":
            raise OSError("the process died")
        return real_copy(source, target)

    if survives == "the copy":
        monkeypatch.setattr(local_format.shutil, "copy2", cut_short)
    else:
        monkeypatch.setattr(LocalStorage, "_write_json", crashing)
    with pytest.raises(OSError):
        LocalStorage(Settings(data_dir=tmp_path))
    assert marker(tmp_path)["format"] == 2
    if survives == "the copy":
        # Nothing was planned or deleted, and the half copy is not taken for the whole one.
        assert "retiring" not in marker(tmp_path) and (knowledge / "pages" / "stats.json").exists()
        assert not (tmp_path / "users" / "reader" / local_format.BEFORE_STUB_CLEANUP).exists()
    else:
        assert list(marker(tmp_path)["retiring"]) == ["stats"]
    monkeypatch.undo()

    assert stub_outcome(tmp_path) == AFTER_STUBS
    assert marker(tmp_path) == {"format": local_format.LOCAL_FORMAT}
    kept = tmp_path / "users" / "reader" / local_format.BEFORE_STUB_CLEANUP / "pages"
    assert sorted(path.name for path in kept.iterdir()) == ["elbo.json", "ml.json", "stats.json"]
    assert json.loads((kept / "stats.json").read_text())["body"] == STUB


def test_a_store_two_formats_behind_takes_both_steps_in_one_open(tmp_path):
    """Format 1 to 5 in one open: every step in `knowledge/`, then the rename, which carries what they left."""
    seed_local(tmp_path)
    assert local_outcome(tmp_path) == EXPECTED
    assert marker(tmp_path) == {"format": local_format.LOCAL_FORMAT}
    # The first step left no stub, so the second kept nothing.
    assert not (tmp_path / "users" / "reader" / local_format.BEFORE_STUB_CLEANUP).exists()
    for owner in SEED:
        user = tmp_path / "users" / owner
        assert not (user / "knowledge").is_dir()
        assert json.loads((user / "memory" / "format.json").read_text()) == {"format": 5}
        assert (user / local_format.BEFORE_RETIREMENT / "pages").is_dir()
        for conversation_id, _, _ in SEED[owner]["conversations"]:
            # The kind is renamed on what the retirement wrote, and the copy is that file, watermark and all.
            name = f"conversations/{conversation_id}.json"
            now, then = (json.loads((user / held).read_text()) for held in (name, f"{local_format.BEFORE_RENAME}/{name}"))
            assert (now["kind"], then["kind"]) == ("memory_chat", "knowledge_base_chat")
            assert {**then, "kind": "memory_chat"} == now and "memoryFiledThrough" in then
        assert sorted(path.name for path in (user / local_format.BEFORE_RENAME).iterdir()) == ["conversations"]
