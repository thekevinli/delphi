"""
`Settings.memory_web_evidence`, off and on (V12, and Stage 7's on path).

Off is how it ships. Maintenance then makes no research call and offers no
web search, an outside claim of the digest is absent from what the agent is
given, and an `external` citation cannot be written onto a concept page: the
write tools hold every citation to the run's closed evidence set, and with
the setting off that set has no outside source in it.

On, gather may look outside (`gather_outside.py`): a question the selection
leaves open is put to the research pass, and the web pages a session's
answers cited are re-grounded. What comes back is a captured passage whose
quote was found on its page, cited as `external`; nothing else reaches the
agent, and the agent and the checker never browse.

Here, the stores' half, on every store the consumer's `store_harness` opens.
The refusal is at the tools and not in the store. A source page carries its
digest's own `external` citations whatever the setting, and a concept page
written while the setting was on has to stay readable and editable after it
is turned off, so the stores accept the claim type on every kind of page.
"""

import pytest

#: The id of the capture core's own tests store and cite (`tests/test_memory_gather.py::CAPTURE`).
CAPTURE_ID = "cap000000000000000000001"
STORED_OUTSIDE = {"id": 3, "claimType": "external", "paperId": None, "page": None, "section": "findings",
                  "noteId": None, "evidenceId": CAPTURE_ID}


@pytest.fixture
def storage(store_harness, tmp_path):
    made = store_harness.make(tmp_path)
    made.create_account("reader", "reader@example.test", "salt", "hash")
    return made


def test_the_stores_keep_an_external_citation_on_every_kind_of_page(storage):
    """Where the refusal is not: a page that holds one is stored, read back and written again."""
    for kind, slug in (("source", "a-paper"), ("concept", "rotary-encoding"), ("domain", "ml")):
        row = {"slug": slug, "kind": kind, "domain": "ml", "title": slug, "summary": "s", "body": "Called RoPE [E3].",
               "citations": [STORED_OUTSIDE], **({"sourcePaperId": "p1"} if kind == "source" else {})}
        written = storage.upsert_memory_page("reader", row, max_pages=50)
        again = storage.upsert_memory_page("reader", {**row, "body": "Called RoPE in later work [E3].", "expectedRevision": written["revision"]}, max_pages=50)
        (kept,) = storage.get_memory_page("reader", slug)["citations"]
        assert again["revision"] == written["revision"] + 1
        assert (kept["claimType"], kept["evidenceId"], kept["section"]) == ("external", CAPTURE_ID, "findings")
