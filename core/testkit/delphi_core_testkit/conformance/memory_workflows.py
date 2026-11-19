"""
Memory as a reader changes it, step by step, and whole after every step.

Each test is a workflow through the app: documents added and filed, pages
deleted one by one as the Delete page dialog shows them, domains deleted in each shape a domain can have, pages
moved by Update, domains named and renamed. After every step
`assert_memory_whole` reads the account back and holds it to what a reader
must never meet, whatever they did:

- a page in a domain no list shows, so nothing reaches it;
- a link to a page that is not there;
- a domain the model named that holds no page, or a domain's own page with
  nothing left to describe;
- a domain the model named holding one page (a field of one), unless the
  step had nowhere to fold it;
- a domain owed its first page with no composition queued;
- anything but a document's page waiting in `general`;
- a queued job, or a figure, belonging to something that has gone.

Filing is the commit a maintenance job ends with (`commit`), staged by hand,
so every store the consumer's `store_harness` opens is held to the same
workflows.
"""

from collections import defaultdict

import pytest

from delphi_core.config import Settings
from delphi_core.memory import MEMORY_VERSION
from delphi_core.memory_maintenance.commit import commit
from delphi_core.memory_maintenance.jobs import DOMAIN_FIRST_PAGE_MEMBERS
from delphi_core.memory_maintenance.run import EvidenceSet
from delphi_core.memory_maintenance.staging import StagedPage
from delphi_core.storage import LocalObjectStore, utc_now
from delphi_core.storage.rules import is_domain_page

from delphi_core_testkit.conformance.memory_routes import signed_in

FIGURE_KEY = "knowledge/u/reader/figures/{}.webp"


@pytest.fixture
def storage(store_harness, tmp_path):
    store = store_harness.make(tmp_path)
    store.create_account("reader", None, "salt", "hash")
    return store


@pytest.fixture
def library(storage, tmp_path):
    """A signed-in client over `storage`, and a project to add documents to."""
    settings = Settings(_env_file=None, data_dir=tmp_path, session_secret="memory-workflows-test")
    project = storage.create_project("reader", "Reading")["id"]
    with signed_in(settings, storage, LocalObjectStore(tmp_path)) as client:
        yield client, project


def assert_memory_whole(storage, client, *, lone=()):
    """
    Everything `reader`'s Memory holds is in sight, linked to what exists and
    owed what it needs; `lone` are the domains a step left with one page and
    nowhere to fold it.
    """
    pages = storage.list_memory_pages("reader", limit=1000)
    slugs = {page["slug"] for page in pages}
    members = defaultdict(list)
    for page in pages:
        if not is_domain_page(page, page["domain"]):
            members[page["domain"]].append(page)
    own = {page["slug"] for page in pages if is_domain_page(page, page["domain"])}
    listed = {entry["slug"] for entry in client.get("/api/memory/domains").json()["domains"]}
    records = {entry["slug"]: entry for entry in storage.memory_domains("reader")}
    jobs = storage.list_memory_jobs("reader")
    composing = {job["payload"]["domain"] for job in jobs if job["kind"] == "domain"}
    problems = []
    problems += [f"{page['slug']} sits in {page['domain']}, which no list shows" for page in pages if page["domain"] not in listed]
    problems += [f"{edge['from']} links to {edge['to']}, which is not there"
                 for edge in storage.list_memory_links("reader") if edge["to"] not in slugs]
    for slug, record in records.items():
        held = members.get(slug, [])
        if record.get("origin") != "reader" and not held:
            problems.append(f"{slug}, named by the model, holds no page")
        if record.get("origin") != "reader" and slug != "general" and len(held) == 1 and slug not in lone:
            problems.append(f"{slug}, named by the model, holds one page")
        if slug != "general" and slug not in own and len(held) >= DOMAIN_FIRST_PAGE_MEMBERS and slug not in composing:
            problems.append(f"{slug} is owed its first page and nothing is queued to write it")
    problems += [f"{slug}'s own page describes no page" for slug in own if not members.get(slug)]
    problems += [f"{page['slug']}, a {page['kind']}, waits in general" for page in members.get("general", []) if page["kind"] != "source"]
    problems += [f"a composition is queued for {slug}, which is gone" for slug in composing if slug not in records]
    problems += [f"a rewrite is queued for {job['payload']['pageSlug']}, which is gone" for job in jobs
                 if job["kind"] == "page-rewrite" and job["payload"].get("pageSlug") not in slugs]
    ids = {storage.get_memory_page("reader", slug)["id"] for slug in slugs}
    problems += [f"figure {figure['id']} belongs to no page" for figure in storage.list_memory_figures("reader")
                 if figure["pageId"] not in ids]
    assert problems == []


def domain_of(storage, slug):
    return storage.get_memory_page("reader", slug)["domain"]


def domains(storage):
    return {entry["slug"] for entry in storage.memory_domains("reader")}


def gone(client, slug):
    return client.get(f"/api/memory/pages/{slug}").status_code == 404


def add_document(storage, project, paper_id, title, body="The digest."):
    """A document added and digested: its page waits in `general` until it is filed."""
    storage.add_paper("reader", project, {"id": paper_id, "title": title, "filename": f"{paper_id}.pdf"})
    slug = title.lower().replace(" ", "-")
    storage.upsert_memory_page("reader", {
        "slug": slug, "kind": "source", "domain": "general", "title": title, "summary": f"{title}, digested.",
        "body": body, "sourcePaperId": paper_id,
    }, max_pages=200)
    return slug


def concept(title, domain, body="Body.", *, paper_id="p0"):
    """A new page as filing stages one, citing `paper_id`."""
    return StagedPage(
        slug=title.lower().replace(" ", "-"), action="create", revision=0, title=title, aliases=(), domain=domain,
        domain_title=domain.replace("-", " ").capitalize(), summary=f"What {title} is.", body=f"{body} [E1]\n",
        citations=({"id": 1, "claimType": "author-claim", "paperId": paper_id, "page": 1, "section": None,
                    "noteId": None, "evidenceId": None},),
        note=f"new page for {title}",
    )


def file(storage, project, paper_id, *pages, start=()):
    """The document's filing job, claimed and committed with `pages`, as the drain runs one."""
    marker = f"paper:{paper_id}"
    storage.enqueue_memory_job("reader", kind="document", marker=marker,
                               payload={"projectId": project, "paperId": paper_id}, target_version=MEMORY_VERSION)
    job = storage.claim_memory_job("reader", now=utc_now(), lease_expires_at="2099-01-01T00:00:00+00:00", max_attempts=6)
    assert job is not None and job["marker"] == marker, job
    evidence = EvidenceSet(kind="document", marker=marker, project_id=project, paper_id=paper_id, title=paper_id,
                           fingerprint=f"f-{paper_id}", start_slugs=tuple(start))
    done = commit(storage, "reader", Settings(), job=job, evidence=evidence, selection=None, pages=list(pages),
                  dropped=[], verdicts=None, authored=None)
    storage.complete_memory_job("reader", job["id"])
    return done


def write(storage, title, domain, body="Body.", kind="concept", **fields):
    """A page as it stands after earlier filing, written straight to the store."""
    slug = fields.pop("slug", title.lower().replace(" ", "-"))
    storage.upsert_memory_page("reader", {"slug": slug, "kind": kind, "domain": domain, "title": title,
                                          "summary": f"What {title} is.", "body": body, **fields}, max_pages=200)
    return slug


def own_page(storage, domain, body):
    return write(storage, domain.replace("-", " ").capitalize(), domain, body, kind="domain", slug=domain)


def delete_page(client, slug, choose=None):
    """The Delete page dialog: what it shows, then the delete, the page its domain would keep sent where `choose` says."""
    plan = client.get(f"/api/memory/pages/{slug}/deletion")
    assert plan.status_code == 200, plan.text
    plan = plan.json()
    body = {"moves": {plan["left"]["slug"]: choose or plan["left"]["suggested"]}} if plan["left"] else None
    deleted = client.request("DELETE", f"/api/memory/pages/{slug}", json=body)
    assert deleted.status_code == 204, deleted.text
    return plan


def delete_domain(client, slug, choose=None):
    """The Delete domain dialog: what it shows, then the delete, each document page sent where `choose` says."""
    plan = client.get(f"/api/memory/domains/{slug}/deletion")
    assert plan.status_code == 200, plan.text
    plan = plan.json()
    moves = {source["slug"]: (choose or {}).get(source["slug"]) or source["suggested"] for source in plan["sources"]}
    deleted = client.request("DELETE", f"/api/memory/domains/{slug}", json={"members": plan["members"], "moves": moves})
    assert deleted.status_code == 200, deleted.text
    return plan, deleted.json()


def test_documents_added_filed_and_deleted_never_leave_memory_broken(storage, library):
    client, project = library
    adam_paper = add_document(storage, project, "p1", "Adam paper")
    assert_memory_whole(storage, client)

    # Filed: its concepts start a domain of three, and its page follows them there.
    file(storage, project, "p1", concept("Adam", "optimizers", "Moments.", paper_id="p1"),
         concept("SGD", "optimizers", "Plain steps.", paper_id="p1"), start=(adam_paper,))
    assert domain_of(storage, adam_paper) == "optimizers"
    assert_memory_whole(storage, client)

    # A second document waits, in sight, while it is filed.
    warmup_paper = add_document(storage, project, "p2", "Warmup paper", "Warms [[adam]] up.")
    assert "general" in {entry["slug"] for entry in client.get("/api/memory/domains").json()["domains"]}
    assert_memory_whole(storage, client)

    # One new page in a new domain: the document's page follows it, and two make a field.
    file(storage, project, "p2", concept("Warmup", "training", "Ramps the rate; see [[adam]].", paper_id="p2"),
         start=(warmup_paper,))
    assert {domain_of(storage, slug) for slug in ("warmup", warmup_paper)} == {"training"}
    assert_memory_whole(storage, client)

    # A third document whose filing wrote nothing still leaves no page waiting.
    momentum_paper = add_document(storage, project, "p3", "Momentum paper", "Builds on [[sgd]].")
    file(storage, project, "p3", start=(momentum_paper,))
    assert domain_of(storage, momentum_paper) == "optimizers"
    assert_memory_whole(storage, client)

    # The second document deleted keeps its page; its page deleted leaves Warmup alone, which folds.
    assert client.delete(f"/api/projects/{project}/papers/p2").status_code == 204
    assert_memory_whole(storage, client)
    assert client.delete(f"/api/memory/pages/{warmup_paper}").status_code == 204
    assert domain_of(storage, "warmup") == "optimizers" and "training" not in domains(storage)
    assert_memory_whole(storage, client)


def test_deleting_pages_one_by_one_takes_a_domain_from_three_to_none(storage, library):
    client, _ = library
    for title in ("Adam", "SGD", "Muon"):
        write(storage, title, "optimizers", "Tuned with [[warmup]].")
    own_page(storage, "optimizers", "From [[sgd]] to [[adam]] and [[muon]].")
    write(storage, "Warmup", "training", "Read [[optimizers]] first.")
    write(storage, "Batch size", "training")
    assert_memory_whole(storage, client)

    # Three to two: the domain keeps its page and is owed it again.
    assert delete_page(client, "adam") == {"domain": None, "left": None, "destinations": []}
    assert storage.get_memory_page("reader", "optimizers")["kind"] == "domain"
    assert "optimizers" in {job["payload"]["domain"] for job in storage.list_memory_jobs("reader") if job["kind"] == "domain"}
    assert_memory_whole(storage, client)

    # Two to one: no field of one. The dialog says Muon joins Training and Optimizers goes with its page.
    shown = delete_page(client, "sgd")
    assert (shown["domain"]["slug"], shown["left"]["slug"], shown["left"]["suggested"]) == ("optimizers", "muon", "training")
    assert domain_of(storage, "muon") == "training"
    assert "optimizers" not in domains(storage) and gone(client, "optimizers")
    assert "[[optimizers]]" not in storage.get_memory_page("reader", "warmup")["body"]
    assert_memory_whole(storage, client)

    # A domain the reader named keeps a page alone, and goes with its last.
    client.post("/api/memory/domains", json={"title": "Reading list"})
    write(storage, "Lion", "reading-list")
    write(storage, "Sophia", "reading-list")
    assert delete_page(client, "lion")["domain"] is None
    assert domain_of(storage, "sophia") == "reading-list"
    assert_memory_whole(storage, client)
    assert delete_page(client, "sophia")["domain"]["slug"] == "reading-list"
    assert "reading-list" not in domains(storage)
    assert_memory_whole(storage, client)


#: What `optimizers` holds in each shape a domain can be deleted in.
SHAPES = {
    "nothing": (),
    "one document": ("adam-paper",),
    "one concept": ("adam",),
    "a document and a concept": ("adam-paper", "adam"),
    "three or more": ("adam-paper", "adam", "sgd", "lion", "muon-paper"),
}


def _shape(storage, shape):
    """`optimizers` holding `shape`, beside `training` and `hiking`, which link into it."""
    held = SHAPES[shape]
    composed = len(held) >= 2
    write(storage, "Warmup", "training", "Pairs with " + " and ".join(
        f"[[{slug}]]" for slug in ("adam", "adam-paper") if slug in held) + "." if held else "Ramps the rate.")
    write(storage, "Batch size", "training", "Read [[optimizers]] first." if composed else "Plain.")
    write(storage, "Switchbacks", "hiking")
    write(storage, "Cairns", "hiking")
    if not held:
        storage.upsert_memory_domain("reader", {"slug": "optimizers", "title": "Optimizers", "origin": "reader"})
    if "adam-paper" in held:
        write(storage, "Adam paper", "optimizers", "Introduces Adam; see [[warmup]].", kind="source", sourcePaperId="p1")
    if "adam" in held:
        write(storage, "Adam", "optimizers", "Moments; see [[warmup]].")
    if "sgd" in held:
        write(storage, "SGD", "optimizers", "Before [[adam]].")
        write(storage, "Lion", "optimizers", "After [[adam]]; tuned as in [[adam-paper]].")
        write(storage, "Muon paper", "optimizers", "Orthogonal steps.", kind="source", sourcePaperId="p2")
        storage.add_memory_figure("reader", {
            "id": "adam-figure", "pageSlug": "adam", "caption": "Moments", "objectKey": FIGURE_KEY.format("adam-figure"),
            "origin": {"paperId": "p1", "page": 2}, "width": 800, "height": 400, "bytes": 20_000,
        }, max_per_page=4)
    if composed:
        own_page(storage, "optimizers", "How " + " and ".join(f"[[{slug}]]" for slug in held[:2]) + " fit.")


@pytest.mark.parametrize("shape", ["nothing", "one document", "one concept", "a document and a concept", "three or more"])
def test_deleting_a_domain_of_any_shape_leaves_memory_whole(storage, library, shape):
    client, _ = library
    _shape(storage, shape)
    assert_memory_whole(storage, client, lone={"optimizers"} if shape in ("one document", "one concept") else ())
    before = {page["slug"]: page for page in storage.list_memory_pages("reader", limit=1000)}

    plan, done = delete_domain(client, "optimizers", choose={"muon-paper": "hiking"})

    assert "optimizers" not in domains(storage) and gone(client, "optimizers")
    # Every document page moved where it was sent, and every other page of the domain went.
    for source in plan["sources"]:
        assert domain_of(storage, source["slug"]) == ("hiking" if source["slug"] == "muon-paper" else source["suggested"])
    for page in plan["pages"]:
        assert gone(client, page["slug"])
    assert {page["slug"] for page in done["moved"]} == {source["slug"] for source in plan["sources"]}
    # What it said would lose a link did, and nothing else changed.
    after = {page["slug"]: page for page in storage.list_memory_pages("reader", limit=1000)}
    unlinked = {page["slug"] for page in plan["unlinked"]}
    changed = {slug for slug in after if slug in before and after[slug]["revision"] != before[slug]["revision"]}
    assert changed <= unlinked
    assert_memory_whole(storage, client)


def test_a_domain_that_changed_under_the_dialog_is_refused_then_deleted_as_shown_again(storage, library):
    client, project = library
    _shape(storage, "a document and a concept")
    shown = client.get("/api/memory/domains/optimizers/deletion").json()

    # Filing adds a page while the dialog is open.
    rmsprop_paper = add_document(storage, project, "p3", "RMSprop paper")
    file(storage, project, "p3", concept("RMSprop", "optimizers", "Per-weight scale.", paper_id="p3"), start=(rmsprop_paper,))
    refused = client.request("DELETE", "/api/memory/domains/optimizers", json={
        "members": shown["members"], "moves": {source["slug"]: source["suggested"] for source in shown["sources"]},
    })
    assert refused.status_code == 409
    assert domain_of(storage, "rmsprop") == "optimizers" and domain_of(storage, "adam") == "optimizers"
    assert_memory_whole(storage, client)

    plan, _ = delete_domain(client, "optimizers")
    assert {"rmsprop", rmsprop_paper} <= set(plan["members"])
    assert gone(client, "rmsprop") and domain_of(storage, rmsprop_paper) != "optimizers"
    assert_memory_whole(storage, client)


def test_the_page_a_domain_would_keep_goes_where_the_reader_chose_once_they_saw_the_domain_as_it_is(storage, library):
    client, project = library
    for title in ("Adam", "SGD"):
        write(storage, title, "optimizers", "Tuned with [[warmup]].")
    for title in ("Warmup", "Batch size"):
        write(storage, title, "training")
    for title in ("Switchbacks", "Cairns"):
        write(storage, title, "hiking")
    shown = client.get("/api/memory/pages/adam/deletion").json()
    assert shown["left"]["suggested"] == "training"

    # Filing adds two pages to Optimizers while the dialog is open: the choice no longer applies.
    rmsprop_paper = add_document(storage, project, "p3", "RMSprop paper", "Compared with [[warmup]] schedules.")
    file(storage, project, "p3", concept("RMSprop", "optimizers", "Per-weight scale.", paper_id="p3"), start=(rmsprop_paper,))
    refused = client.request("DELETE", "/api/memory/pages/adam", json={"moves": {"sgd": "hiking"}})
    assert refused.status_code == 409 and domain_of(storage, "adam") == "optimizers"
    assert_memory_whole(storage, client)

    # Looked at again, Adam's delete touches nothing else.
    assert delete_page(client, "adam")["domain"] is None
    assert delete_page(client, "rmsprop")["domain"] is None
    assert_memory_whole(storage, client)

    # SGD is the second-to-last: the document's page left behind goes where the reader picks, not where it links.
    shown = delete_page(client, "sgd", choose="hiking")
    assert (shown["left"]["slug"], shown["left"]["suggested"]) == (rmsprop_paper, "training")
    assert domain_of(storage, rmsprop_paper) == "hiking" and "optimizers" not in domains(storage)
    assert_memory_whole(storage, client)


def test_update_moves_never_strand_a_domain(storage, library):
    client, _ = library
    for title in ("Adam", "SGD", "Muon"):
        write(storage, title, "optimizers", "Tuned with [[warmup]].")
    own_page(storage, "optimizers", "From [[sgd]] to [[adam]].")
    write(storage, "Warmup", "training")
    write(storage, "Batch size", "training")
    write(storage, "Switchbacks", "hiking")
    write(storage, "Cairns", "hiking")
    assert_memory_whole(storage, client)

    # Two of three moved: the third would be alone, so it follows its links.
    assert client.post("/api/memory/pages/move", json={"moves": {"adam": "training", "sgd": "training"}}).status_code == 200
    assert domain_of(storage, "muon") == "training" and "optimizers" not in domains(storage)
    assert_memory_whole(storage, client)

    # Every page moved out: the domain goes with the move.
    assert client.post("/api/memory/pages/move", json={"moves": {"switchbacks": "training", "cairns": "training"}}).status_code == 200
    assert "hiking" not in domains(storage)
    assert_memory_whole(storage, client)

    # Nothing moves into general.
    assert client.post("/api/memory/pages/move", json={"moves": {"adam": "general"}}).status_code == 422
    assert_memory_whole(storage, client)


def test_a_domain_the_reader_names_renames_and_deletes_stays_in_sight_throughout(storage, library):
    client, _ = library
    write(storage, "Adam", "optimizers")
    write(storage, "SGD", "optimizers")

    created = client.post("/api/memory/domains", json={"title": "Reading list"})
    assert created.status_code == 200
    assert "reading-list" in {entry["slug"] for entry in client.get("/api/memory/domains").json()["domains"]}
    assert_memory_whole(storage, client)

    assert client.patch("/api/memory/domains/reading-list", json={"title": "To read"}).status_code == 200
    assert client.patch("/api/memory/domains/general", json={"title": "Model architectures"}).status_code == 422
    assert client.post("/api/memory/domains", json={"title": "General"}).status_code == 422
    assert_memory_whole(storage, client)

    # Filed into by hand, then deleted with what is in it.
    assert client.post("/api/memory/pages/move", json={"moves": {"adam": "reading-list"}}).status_code == 200
    assert_memory_whole(storage, client, lone={"optimizers"})
    plan, _ = delete_domain(client, "reading-list")
    assert [page["slug"] for page in plan["pages"]] == ["adam"] and gone(client, "adam")
    assert_memory_whole(storage, client, lone={"optimizers"})


def test_a_document_waiting_to_be_filed_is_in_sight_and_never_strands(storage, library):
    client, project = library
    # The first document of a library has nowhere to go until it is filed: it waits, listed.
    first = add_document(storage, project, "p1", "Attention paper")
    file(storage, project, "p1", start=(first,))
    assert domain_of(storage, first) == "general"
    assert_memory_whole(storage, client)
    assert client.request("DELETE", "/api/memory/domains/general", json={
        "members": [first], "moves": {first: "general"},
    }).status_code == 422

    # Filed again with pages, it goes where they went, and general is listed no more.
    file(storage, project, "p1", concept("Attention", "transformers", "Weighs tokens.", paper_id="p1"), start=(first,))
    assert domain_of(storage, first) == "transformers"
    assert "general" not in {entry["slug"] for entry in client.get("/api/memory/domains").json()["domains"]}
    assert_memory_whole(storage, client)
