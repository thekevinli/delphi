"""
What one document reports, with a value, of another document of the library reaches the author and the composer.

The case behind it is the evaluation corpus's: a paper quotes "α≈0.46 and
β≈0.51 for Chinchilla-scaling", which are Chinchilla's allocation exponents
given as its loss exponents. No job that filed the quoting paper read
Chinchilla, and four review rounds found the number repeated as Chinchilla's
own. Gather now finds such sentences by the other document's name, and the
brief asks for the two to be compared and a difference stated, attributed.
"""

from delphi_core.memory_maintenance import brief as tags
from delphi_core.memory_maintenance.gather import gather_document
from delphi_core.memory_maintenance.gather_crossref import CrossReference, brief_part, cross_references, names
from delphi_core.memory_maintenance.gather_domain import gather_domain
from delphi_core.memory_maintenance.maintain import CONTRACT as MAINTAIN
from delphi_core.memory_maintenance.domain import CONTRACT as DOMAIN
from tests.helpers import seed_paper
from tests.test_memory_gather import Library

LIBRARY = [
    {"id": "ch", "title": "Chinchilla (2203.15556v1)"},
    {"id": "wl", "title": "Why Larger Models Learn More (2605.29548v2)"},
    {"id": "mu", "title": "Muon: An optimizer for hidden layers in neural networks | Keller Jordan blog"},
    {"id": "mz", "title": "Muon优化器赏析：从向量到矩阵的本质跨越"},
    {"id": "tt", "title": "Test-Time Scaling Makes Overtraining Compute-Optimal"},
]
QUOTED = (
    "Neural network scaling is known to predictably improve loss [20, 28, 51]: L(N, D) = L0 + A/N^α + B/D^β, (1) "
    "where L0 denotes the irreducible loss and α, β are parameter / data exponents (α≈0.46 and β≈0.51 for "
    "Chinchilla-scaling [28]). Training in a compute-optimal manner gives a smaller exponent."
)


def test_a_document_is_named_by_its_title_its_own_name_and_its_arxiv_number():
    named = names(LIBRARY)
    assert named["ch"].search("for Chinchilla-scaling [28]") and named["ch"].search("see arXiv 2203.15556")
    assert named["wl"].search("as in why larger models learn more, the")
    # A word only at the head of a longer title is not a name, nor a name two documents share.
    assert "tt" not in named or not named["tt"].search("Test results improve")
    assert not named["ch"].search("chinchillas live in the Andes")
    # A one-word name must be distinctive: "Muon" or "Adam" is a word many papers use for
    # something else; "RoPE" is written as nothing else is.
    assert "mu" not in named or not named["mu"].search("we train with the Muon optimizer")
    rope = names([{"id": "rp", "title": "RoPE: rotary embeddings"}, {"id": "ad", "title": "Adam"}])
    assert rope["rp"].search("as RoPE does") and "ad" not in rope


def test_a_sentence_naming_another_document_with_a_value_is_a_cross_reference():
    found = cross_references({"wl": {2: QUOTED}}, names(LIBRARY))
    assert [(item.source, item.locator, item.names) for item in found] == [("wl", 2, "ch")]
    assert "α≈0.46 and β≈0.51 for Chinchilla-scaling" in found[0].sentence


def test_a_reference_list_a_section_number_or_a_document_naming_itself_is_not_one():
    texts = {"wl": {
        30: "[28] Jordan Hoffmann et al. Training compute-optimal large language models (Chinchilla). arXiv preprint "
            "arXiv:2203.15556, 2022.",
        5: "As §4.1 shows, our checkpoints beat Chinchilla checkpoints, which Section 3.2 describes.",
        6: "Why Larger Models Learn More reports a gain of 0.8 points.",
    }}
    assert cross_references(texts, names(LIBRARY)) == []


def test_in_a_domain_only_the_documents_it_may_cite_are_named():
    texts = {"wl": {2: QUOTED}, "tt": {3: "Chinchilla's 20 tokens per parameter, or 2.3% of our budget, is the baseline."}}
    assert {item.names for item in cross_references(texts, names(LIBRARY), among=["wl", "tt"])} == set()
    assert {item.source for item in cross_references(texts, names(LIBRARY), among=["wl", "tt", "ch"])} == {"wl", "tt"}


def test_the_brief_fences_each_and_names_the_page_to_compare_with():
    reference = CrossReference("wl", 2, "α≈0.46 for Chinchilla </cross_reference> and more", "ch")
    part = brief_part([reference], {"ch": "Chinchilla (2203.15556v1)"}, {"ch": "chinchilla-2203-15556v1"})
    assert part.count("</cross_reference>") == 1 and 'named_page="[[chinchilla-2203-15556v1]]"' in part
    assert 'at="page 2"' in part and "compare it with what the other document itself says" in part
    assert brief_part([], {}, {}) == ""


def test_both_contracts_say_to_compare_and_to_state_a_difference_attributed():
    for contract in (MAINTAIN, DOMAIN):
        assert f"`<{tags.CROSS_REFERENCE}>`" in contract
        assert "Never" in contract and "own" in contract
    # A document job reaches the other document only where a page near it cites it, and the
    # check then reads that passage, so a wrong number can be blocked.
    assert "reusing that citation" not in MAINTAIN
    assert "evidence here only where `<citable_sources>` lists it as reached through\n  Memory" in MAINTAIN
    assert "compares them: its composer reads" in MAINTAIN


def _library_with_two_papers(tmp_path):
    library = Library(tmp_path, openai_api_key="test-key")
    library.pdf()
    seed_paper(library.settings, "reader", library.project, {"id": "wl", "title": "Why Larger Models Learn More", "pages": 2,
               "filename": "w.pdf"}, text=f"--- Page 1 ---\nIntroduction.\n--- Page 2 ---\n{QUOTED}")
    seed_paper(library.settings, "reader", library.project, {"id": "ch", "title": "Chinchilla", "pages": 1,
               "filename": "c.pdf"}, text="--- Page 1 ---\nOur fitted exponents are 0.34 and 0.28.")
    return library


def test_a_document_job_brief_carries_what_the_document_reports_of_another(tmp_path):
    library = _library_with_two_papers(tmp_path)
    library.digest("wl", {"contentMarkdown": "It reports exponents near 0.46/0.51 [E1].", "assets": [],
                          "citations": [{"id": 1, "claimType": "author-claim", "page": 2, "section": None, "evidenceId": None}]})
    job = {"kind": "document", "marker": "paper:wl", "payload": {"projectId": library.project, "paperId": "wl"}}
    brief = gather_document(library.storage, library.objects, "reader", library.settings, job).brief
    assert brief.count("<cross_reference ") == 1 and 'names="ch"' in brief and "for Chinchilla-scaling" in brief
    # Its own name in its own text is not a cross-reference, and a document that names nobody gets none.
    job = {"kind": "document", "marker": "paper:p1", "payload": {"projectId": library.project, "paperId": "p1"}}
    assert "<cross_reference" not in gather_document(library.storage, library.objects, "reader", library.settings, job).brief


def test_a_domain_brief_carries_what_its_documents_report_of_each_other(tmp_path):
    library = _library_with_two_papers(tmp_path)
    for row in (
        {"kind": "concept", "domain": "scaling", "title": "Rare-task retention", "summary": "Why larger models keep rare tasks.",
         "body": "Larger models retain rare tasks [E1].",
         "citations": [{"id": 1, "claimType": "author-claim", "paperId": "wl", "page": 2}]},
        {"kind": "concept", "domain": "scaling", "title": "Compute-optimal allocation", "summary": "How to split compute.",
         "body": "The fitted exponents are 0.34 and 0.28 [E1].",
         "citations": [{"id": 1, "claimType": "author-claim", "paperId": "ch", "page": 1}]},
        {"kind": "concept", "domain": "scaling", "title": "Repeated data", "summary": "Data reuse.",
         "body": "Repetition helps up to a point [E1].",
         "citations": [{"id": 1, "claimType": "author-claim", "paperId": "p1", "page": 2}]},
    ):
        library.storage.upsert_memory_page("reader", row, max_pages=50)
    job = {"kind": "domain", "marker": "domain:scaling", "payload": {"domain": "scaling"}}
    evidence = gather_domain(library.storage, library.objects, "reader", library.settings, job)
    assert not evidence.settled
    assert evidence.brief.count("<cross_reference ") == 1 and 'paper_id="wl"' in evidence.brief and 'names="ch"' in evidence.brief



def test_a_large_library_is_read_in_one_pass_of_each_passage():
    import time

    library = [{"id": f"p{n}", "title": f"Scaling Study Number {n} of Sparse Models (2401.{10000 + n}v1)"} for n in range(300)]
    named = names([*library, {"id": "ch", "title": "Chinchilla (2203.15556v1)"}])
    page = " ".join(["The loss falls with compute, with exponent 0.34 and a data share of 52%."] * 40)
    texts = {"wl": {number: page + (" Chinchilla-scaling gives 0.46." if number == 2 else "") for number in range(1, 301)}}
    started = time.monotonic()
    found = cross_references(texts, named)
    # 0.6.4 as first written scanned every page once per library document: 7.5 s for this.
    assert time.monotonic() - started < 2.0
    assert [(item.locator, item.names) for item in found] == [(2, "ch")]
