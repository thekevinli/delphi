"""
Local format 6: no domain whose pages all left it.

From format 6 a domain removes itself when its last page leaves
(`delphi_core/storage/domains.py`). Before it, such a domain stayed in
`domains.json` for good, drawn nowhere and out of reach of every control. The
step (`delphi_core/storage/local_format.py`) drops each one a model named,
with its own page and what that page held, after keeping `domains.json` and
those pages in `memory.format-5/`. A domain with members keeps its page,
however few: its job composes it again as they change. The stores are seeded
as format 5 left them.
"""

import json

import pytest

from delphi_core.config import Settings
from delphi_core.storage import LocalObjectStore, LocalStorage, local_format
from delphi_core.storage.base import parse_wiki_links

THEN = "2026-10-29T00:00:00+00:00"
FIGURE_KEY = "knowledge/u/reader/figures/{}.webp"
#: The page that names the others, as a concept the reader kept would.
LINKER = "Unlike [[ai-learning-paradigms]] and [[reinforcement-learning|RL]], see [[optimizers]]."


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def domain(slug, title, origin="model"):
    return {"slug": slug, "title": title, "summary": None, "origin": origin, "position": 0,
            "createdAt": THEN, "updatedAt": THEN}


def page(slug, kind, domain_slug, title, body="Body.", *, revision=1, citations=()):
    return {"id": f"id-{slug}", "slug": slug, "kind": kind, "domain": domain_slug, "title": title,
            "summary": f"About {title}.", "body": body, "tags": [], "aliases": [], "citations": list(citations),
            "links": parse_wiki_links(body), "revision": revision, "createdAt": THEN, "updatedAt": THEN}


def figure(figure_id, page_id):
    return {"id": figure_id, "pageId": page_id, "pageSlug": "", "caption": "c",
            "objectKey": FIGURE_KEY.format(figure_id), "createdAt": THEN}


def job(slug):
    return {"id": f"job-{slug}", "kind": "domain", "marker": f"domain:{slug}", "payload": {"domain": slug},
            "status": "pending", "attempts": 0, "createdAt": THEN}


def seed_format_five(root, *, stale=True):
    """
    An account as format 5 left it. `optimizers` holds three members and the
    page composed from them. With `stale`, it also holds what the owner's
    library held: two model domains whose pages all left (one never composed,
    one whose composed page a member links to), Reinforcement Learning down to
    one member under a page that cites documents since deleted, an empty
    domain the reader made, and a composed page whose domain has no record and
    no member.
    """
    user = root / "users" / "reader"
    write(user / "account.json", {"username": "reader", "email": None, "passwordSalt": "s", "passwordHash": "h",
                                  "useStandardTier": True, "createdAt": THEN})
    write(user / "knowledge", local_format.FORMER_PLACE)
    memory = user / "memory"
    write(memory / "format.json", {"format": 5})
    domains = [domain("optimizers", "Optimizers")]
    pages = [
        page("adam", "concept", "optimizers", "Adam", LINKER if stale else "See [[optimizers]].", revision=3),
        page("sgd", "concept", "optimizers", "SGD"),
        page("rmsprop", "concept", "optimizers", "RMSprop"),
        page("optimizers", "domain", "optimizers", "Optimizers", "How [[adam]], [[sgd]] and [[rmsprop]] fit."),
    ]
    figures = [figure("adam-figure", "id-adam")]
    jobs = [job("optimizers")]
    if stale:
        domains += [
            domain("diffusion-language-models", "Diffusion language models"),
            domain("ai-learning-paradigms", "AI learning paradigms"),
            domain("reinforcement-learning", "Reinforcement Learning"),
            domain("roman-history", "Roman history", origin="reader"),
        ]
        dead = [{"id": n, "claimType": "author-claim", "paperId": "bb6532fec9be", "page": n} for n in (1, 2)]
        pages += [
            page("ai-learning-paradigms", "domain", "ai-learning-paradigms", "AI learning paradigms",
                 "How [[adam]] once fit.", revision=2),
            page("learning-with-latent-thoughts", "concept", "reinforcement-learning", "Learning with latent thoughts"),
            page("reinforcement-learning", "domain", "reinforcement-learning", "Reinforcement Learning",
                 "How [[learning-with-latent-thoughts]] and two pages since deleted fit [E1] [E2].", revision=6,
                 citations=dead),
            page("unrecorded", "domain", "unrecorded", "Unrecorded", "How pages that left fit."),
        ]
        figures.append(figure("paradigm-figure", "id-ai-learning-paradigms"))
        jobs += [job("ai-learning-paradigms"), job("reinforcement-learning")]
        write(memory / "versions" / "ai-learning-paradigms" / "00000002.json", {
            "slug": "ai-learning-paradigms", "revision": 2, "title": "AI learning paradigms", "summary": "",
            "body": "How [[adam]] once fit.", "citations": [], "createdAt": THEN, "eventId": None,
            "trigger": "domain", "note": None})
    write(memory / "domains.json", domains)
    for record in pages:
        write(memory / "pages" / f"{record['slug']}.json", record)
    write(memory / "figures.json", figures)
    for record in figures:
        (memory / "figures").mkdir(parents=True, exist_ok=True)
        (memory / "figures" / f"{record['id']}.webp").write_bytes(b"RIFF")
    write(memory / "jobs.json", jobs)
    write(memory / "events.json", [])
    write(memory / "graph.json", {"revision": 4})
    return user


def tree(root):
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


def opened(root):
    return LocalStorage(Settings(_env_file=None, data_dir=root))


@pytest.fixture(autouse=True)
def unseen():
    """Each test opens its stores as a new process would."""
    local_format._CURRENT.clear()
    yield
    local_format._CURRENT.clear()


def test_a_format_five_store_drops_the_domains_its_pages_all_left(tmp_path):
    user = seed_format_five(tmp_path)
    memory = user / "memory"
    before = tree(user)

    storage = opened(tmp_path)

    assert read(memory / "format.json") == {"format": local_format.LOCAL_FORMAT} == {"format": 6}
    # The model's empty domains go, the one a page names with no record too;
    # the reader's stays, since nothing says it was not named a minute ago; a
    # domain with members stays, with its page, however few they are.
    kept_domains = ["optimizers", "reinforcement-learning", "roman-history"]
    assert [record["slug"] for record in read(memory / "domains.json")] == kept_domains
    assert sorted(entry["slug"] for entry in storage.memory_domains("reader")) == kept_domains
    # An empty domain's page went as any deleted page goes: versions, figure
    # row and bytes, and links to it, now its words.
    for slug in ("ai-learning-paradigms", "unrecorded"):
        assert not (memory / "pages" / f"{slug}.json").exists() and not (memory / "versions" / slug).exists()
    assert storage.get_memory_page("reader", "optimizers")["kind"] == "domain"
    assert storage.get_memory_page("reader", "reinforcement-learning")["revision"] == 6
    assert [record["id"] for record in read(memory / "figures.json")] == ["adam-figure"]
    objects = LocalObjectStore(tmp_path)
    assert not objects.exists(FIGURE_KEY.format("paradigm-figure")) and objects.exists(FIGURE_KEY.format("adam-figure"))
    adam = storage.get_memory_page("reader", "adam")
    assert adam["body"] == "Unlike AI learning paradigms and [[reinforcement-learning|RL]], see [[optimizers]]."
    assert adam["links"] == ["reinforcement-learning", "optimizers"] and adam["revision"] == 4
    [row] = storage.list_page_versions("reader", "adam")
    assert (row["revision"], row["note"], row["trigger"]) == (4, local_format.EMPTY_DOMAIN_LINK_NOTE, None)
    # A dropped domain's queued composition goes, and every domain that stays
    # is owed one, the reader's empty domain too; each waits for its domain to
    # settle, as any change's composition does.
    jobs = read(memory / "jobs.json")
    assert sorted(entry["marker"] for entry in jobs) == [
        "domain:optimizers", "domain:reinforcement-learning", "domain:roman-history"]
    assert all(entry["kind"] == "domain" and entry["status"] == "pending" and entry["retryAt"] for entry in jobs)
    assert read(memory / "graph.json") == {"revision": 5}
    # What was deleted is kept beside it, as format 5 left it.
    assert tree(user / local_format.BEFORE_EMPTY_DOMAINS) == {
        "domains.json": before["memory/domains.json"],
        **{f"pages/{slug}.json": before[f"memory/pages/{slug}.json"] for slug in ("ai-learning-paradigms", "unrecorded")},
    }
    # The rest of Memory is as it was.
    after = tree(user)
    touched = ("memory/pages/adam", "memory/pages/ai-", "memory/pages/unrecorded", "memory/versions/",
               "memory/figures/paradigm", "memory/domains", "memory/figures.json", "memory/jobs", "memory/graph",
               "memory/format")
    untouched = {name for name in before if not name.startswith(touched)}
    assert {name: after[name] for name in untouched} == {name: before[name] for name in untouched}


def test_an_interrupted_step_finishes_from_the_plan_it_wrote_first(tmp_path, monkeypatch):
    user = seed_format_five(tmp_path)
    memory = user / "memory"
    finish = local_format._drop_domain_pages

    def cut_short(store, user_dir, pages, plan):
        (memory / "pages" / "ai-learning-paradigms.json").unlink()
        raise OSError("the disk filled")

    monkeypatch.setattr(local_format, "_drop_domain_pages", cut_short)
    with pytest.raises(OSError):
        opened(tmp_path)
    marker = read(memory / "format.json")
    assert marker["format"] == 5
    assert sorted(marker["dropping"]["domains"]) == ["ai-learning-paradigms", "diffusion-language-models", "unrecorded"]
    assert sorted(marker["dropping"]["pages"]) == ["ai-learning-paradigms", "unrecorded"]

    monkeypatch.setattr(local_format, "_drop_domain_pages", finish)
    local_format._CURRENT.clear()
    storage = opened(tmp_path)

    # The page's file was already gone, and the plan still named its title.
    assert storage.get_memory_page("reader", "adam")["body"] == (
        "Unlike AI learning paradigms and [[reinforcement-learning|RL]], see [[optimizers]].")
    assert [record["slug"] for record in read(memory / "domains.json")] == [
        "optimizers", "reinforcement-learning", "roman-history"]
    assert read(memory / "format.json") == {"format": 6}
    assert (user / local_format.BEFORE_EMPTY_DOMAINS / "pages" / "ai-learning-paradigms.json").exists()


def test_a_store_with_nothing_to_drop_changes_only_its_marker_and_its_queue(tmp_path):
    user = seed_format_five(tmp_path, stale=False)
    before = tree(user)

    opened(tmp_path)

    after = tree(user)
    assert read(user / "memory" / "format.json") == {"format": 6}
    assert [entry["marker"] for entry in read(user / "memory" / "jobs.json")] == ["domain:optimizers"]
    unqueued = {"memory/format.json", "memory/jobs.json"}
    assert {name: held for name, held in after.items() if name not in unqueued} == \
        {name: held for name, held in before.items() if name not in unqueued}
    assert not (user / local_format.BEFORE_EMPTY_DOMAINS).exists()


def test_document_pages_waiting_in_general_stay_there_and_queue_no_composition(tmp_path):
    """`general` is where a document's page waits to be filed, never a field with a page of its own."""
    user = seed_format_five(tmp_path, stale=False)
    for name in ("adam", "sgd", "rmsprop"):
        path = user / "memory" / "pages" / f"{name}.json"
        write(path, {**read(path), "domain": "general", "kind": "source"})
    (user / "memory" / "pages" / "optimizers.json").unlink()
    write(user / "memory" / "domains.json", [domain("general", "General")])
    write(user / "memory" / "jobs.json", [])

    opened(tmp_path)

    assert read(user / "memory" / "jobs.json") == []
    assert {read(user / "memory" / "pages" / f"{name}.json")["domain"] for name in ("adam", "sgd", "rmsprop")} == {"general"}


def test_general_the_reader_named_becomes_a_domain_under_its_name(tmp_path):
    """
    The owner renamed `general` Model Architectures and filed concepts there:
    a domain to them. It moves, record and concepts, to the slug of its name,
    and is composed as any domain is; links are by page and do not move. A
    document's page waiting there stays, for its filing to place.
    """
    user = seed_format_five(tmp_path, stale=False)
    memory = user / "memory"
    for name in ("adam", "sgd"):
        path = memory / "pages" / f"{name}.json"
        write(path, {**read(path), "domain": "general"})
    write(memory / "pages" / "attention-paper.json",
          page("attention-paper", "source", "general", "Attention paper", "Defines [[adam]]."))
    write(memory / "domains.json", [
        domain("optimizers", "Optimizers"),
        {**domain("general", "Model Architectures", origin="reader"), "summary": "Mine.", "position": -1},
    ])
    before = {name: read(memory / "pages" / f"{name}.json") for name in ("adam", "sgd")}
    waiting = read(memory / "pages" / "attention-paper.json")

    store = opened(tmp_path)

    records = {record["slug"]: record for record in read(memory / "domains.json")}
    assert "general" not in records
    assert {key: records["model-architectures"][key] for key in ("title", "summary", "origin", "position")} == {
        "title": "Model Architectures", "summary": "Mine.", "origin": "reader", "position": -1,
    }
    for name, was in before.items():
        now = read(memory / "pages" / f"{name}.json")
        assert now["domain"] == "model-architectures"
        assert {key: now[key] for key in ("slug", "body", "links", "revision")} == {
            key: was[key] for key in ("slug", "body", "links", "revision")}
        assert read(user / local_format.BEFORE_EMPTY_DOMAINS / "pages" / f"{name}.json") == was
    assert read(memory / "pages" / "attention-paper.json") == waiting
    assert "model-architectures" in {job["payload"]["domain"] for job in read(memory / "jobs.json")}
    assert "general" not in {record["slug"] for record in read(memory / "domains.json")}
    assert store.get_memory_page("reader", "attention-paper")["domain"] == "general"


def test_general_holding_a_concept_becomes_a_domain_called_general(tmp_path):
    """Nothing files a concept into `general` from format 6, so one already there was filed by hand: a domain, kept."""
    user = seed_format_five(tmp_path, stale=False)
    memory = user / "memory"
    path = memory / "pages" / "adam.json"
    write(path, {**read(path), "domain": "general"})
    write(memory / "pages" / "waiting-paper.json", page("waiting-paper", "source", "general", "Waiting paper"))

    opened(tmp_path)

    records = {record["slug"]: record for record in read(memory / "domains.json")}
    assert (records["general-2"]["title"], records["general-2"]["origin"]) == ("General", "model")
    assert read(path)["domain"] == "general-2"
    assert read(memory / "pages" / "waiting-paper.json")["domain"] == "general"


def test_a_documents_page_leaves_general_with_the_pages_written_from_it(tmp_path):
    """
    The owner's "Model Architectures" held two MoE concepts written from a
    handbook, and the handbook's own page: it goes with them, as it would have
    followed the first of them. A post nothing was written from waits on.
    """
    user = seed_format_five(tmp_path, stale=False)
    memory = user / "memory"
    cites = [{"paperId": "handbook", "claimType": "stated"}]
    write(memory / "pages" / "moe-routing.json", page("moe-routing", "concept", "general", "MoE routing", citations=cites))
    write(memory / "pages" / "load-balancing.json", page("load-balancing", "concept", "general", "Load balancing", citations=cites))
    write(memory / "pages" / "moe-handbook.json", {**page("moe-handbook", "source", "general", "MoE handbook"), "sourcePaperId": "handbook"})
    write(memory / "pages" / "a-post.json", {**page("a-post", "source", "general", "A post"), "sourcePaperId": "post"})
    write(memory / "domains.json", [*read(memory / "domains.json"), domain("general", "Model Architectures", origin="reader")])

    opened(tmp_path)

    where = {slug: read(memory / "pages" / f"{slug}.json")["domain"]
             for slug in ("moe-routing", "load-balancing", "moe-handbook", "a-post")}
    assert where == {"moe-routing": "model-architectures", "load-balancing": "model-architectures",
                     "moe-handbook": "model-architectures", "a-post": "general"}
    assert (user / local_format.BEFORE_EMPTY_DOMAINS / "pages" / "moe-handbook.json").exists()


def test_an_interrupted_step_moves_the_pages_its_plan_named(tmp_path):
    """The concepts moved before the run was cut short; the handbook's page, named in the plan, still goes."""
    user = seed_format_five(tmp_path, stale=False)
    memory = user / "memory"
    cites = [{"paperId": "handbook", "claimType": "stated"}]
    write(memory / "pages" / "moe-routing.json", page("moe-routing", "concept", "model-architectures", "MoE routing", citations=cites))
    write(memory / "pages" / "moe-handbook.json", {**page("moe-handbook", "source", "general", "MoE handbook"), "sourcePaperId": "handbook"})
    write(memory / "domains.json", [*read(memory / "domains.json"), domain("general", "Model Architectures", origin="reader")])
    write(memory / "format.json", {"format": 5, "dropping": {
        "general": "model-architectures", "leaving": ["moe-handbook", "moe-routing"], "domains": [], "pages": {}}})

    opened(tmp_path)

    assert read(memory / "pages" / "moe-handbook.json")["domain"] == "model-architectures"
    assert read(memory / "format.json") == {"format": 6}


def test_general_the_reader_only_reordered_stays_where_pages_wait(tmp_path):
    """A reorder marks `general`'s record the reader's; it is no name, and documents' pages wait on in it."""
    user = seed_format_five(tmp_path, stale=False)
    memory = user / "memory"
    write(memory / "pages" / "waiting-paper.json", page("waiting-paper", "source", "general", "Waiting paper"))
    write(memory / "domains.json", [
        *read(memory / "domains.json"), {**domain("general", "General", origin="reader"), "position": 3},
    ])

    opened(tmp_path)

    assert read(memory / "pages" / "waiting-paper.json")["domain"] == "general"
    assert not any(record["slug"].startswith("general-") for record in read(memory / "domains.json"))


def test_a_store_at_format_six_is_not_stepped_again(tmp_path, monkeypatch):
    seed_format_five(tmp_path)
    opened(tmp_path)
    held = tree(tmp_path)

    def refuse(*args, **kwargs):
        raise AssertionError("the step ran twice")

    monkeypatch.setattr(local_format, "_drop_empty_domains", refuse)
    local_format._CURRENT.clear()
    opened(tmp_path)

    assert tree(tmp_path) == held


def test_the_rule_reads_the_files_as_format_five_wrote_them():
    """The marked lines decide, and they are the web revision's text: a model's empty domain, never a reader's."""
    domains = [domain("a", "A"), domain("b", "B"), domain("c", "C", origin="reader"), domain("d", "D")]
    pages = [page("x", "concept", "a", "X"), page("b", "domain", "b", "B"), page("d", "concept", "b", "D"),
             page("c", "domain", "c", "C"), page("e", "domain", "e", "E")]
    # `b` holds `d`; `d`'s only page is filed elsewhere, and a page named like a
    # domain is not that domain's own; `e` has a page of its own and no record.
    assert local_format.empty_domains(domains, pages) == ["d", "e"]
