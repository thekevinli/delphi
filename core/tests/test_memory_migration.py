"""The pure helpers the KB is built on."""

from delphi_core.storage.base import (
    memory_slug,
    parse_figure_refs,
    parse_wiki_links,
)


def test_a_slug_is_the_route_alphabet_so_a_model_can_type_one():
    assert memory_slug("KL Divergence") == "kl-divergence"
    assert memory_slug("Rényi's α") == "renyis"
    assert memory_slug("!!!") == ""


def test_wiki_links_are_ordered_deduplicated_and_slugged():
    body = "See [[Variational Inference]], [[variational inference]] and [[ELBO|the bound]]."

    assert parse_wiki_links(body) == ["variational-inference", "elbo"]


def test_figure_refs_only_match_delphi_locators():
    body = (
        "![the gap](figure:abc123) and ![remote](https://example.test/x.png) "
        "and ![again](figure:abc123)"
    )

    # A remote address in a rendered body is the favicon problem with a larger
    # blast radius, so it is not a figure reference at all.
    assert parse_figure_refs(body) == ["abc123"]
