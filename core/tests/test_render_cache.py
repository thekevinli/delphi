"""What a render may answer from an earlier one: only what its publisher calls immutable."""
import pytest

from delphi_core.render_cache import ImmutableResponses, as_text, is_immutable

CHUNK = {"cache-control": "public,max-age=31536000,immutable", "content-type": "text/javascript",
         "content-encoding": "br", "content-length": "12", "vary": "Accept-Encoding, Available-Dictionary",
         "set-cookie": "__cf_bm=abc; Domain=notion.site", "etag": 'W/"268d"'}


@pytest.mark.parametrize(("status", "headers", "kept"), [
    (200, CHUNK, True),
    (404, CHUNK, False),
    (206, CHUNK, False),
    (200, {"cache-control": "public, max-age=31536000"}, False),
    (200, {"cache-control": "private, max-age=31536000, immutable"}, False),
    (200, {"cache-control": "no-store, immutable"}, False),
    (200, {"cache-control": "immutable"}, False),
    (200, {"cache-control": "max-age=0, immutable"}, False),
    (200, {"Cache-Control": "max-age=600, immutable", "Vary": "Origin"}, False),
    (200, {"Cache-Control": "max-age=600, immutable", "Vary": "accept-encoding"}, True),
])
def test_only_a_response_its_publisher_calls_immutable_is_kept(status, headers, kept):
    assert is_immutable(status, headers) is kept


def test_a_kept_response_is_the_decoded_body_without_the_exchange_it_came_in():
    responses = ImmutableResponses()
    chunk = "https://a.notion.site/_assets/app-1.js"
    assert responses.put(("a.notion.site", chunk), 200, {**CHUNK, "link": "</a.css>; rel=preload\n</b.css>; rel=preload"},
                         b"console.log()")
    headers, body = responses.get(("a.notion.site", chunk))
    names = [header["name"].lower() for header in headers]
    assert body == b"console.log()"
    # The body is past its encoding and length; the cookie was the exchange's.
    assert {"content-type", "cache-control", "etag"} <= set(names)
    assert not set(names) & {"set-cookie", "content-encoding", "content-length"}
    # A repeated header DevTools joined is one header each again, as a fulfil requires.
    assert names.count("link") == 2 and not any("\n" in header["value"] for header in headers)
    # Another host's same path is another resource.
    assert responses.get(("b.notion.site", "https://b.notion.site/_assets/app-1.js")) is None


def test_a_response_is_answered_only_to_renders_of_the_page_that_was_sent_it():
    """A page's service worker can call its own script a CDN's and immutable;
    shared across sites, one page would run itself in every later render."""
    responses = ImmutableResponses()
    library = "https://cdnjs.example/react.min.js"
    responses.put(("hostile.example", library), 200, CHUNK, b"steal()")
    assert responses.get(("notes.example", library)) is None
    assert responses.get(("hostile.example", library))[1] == b"steal()"


def test_a_text_body_held_as_utf8_says_so():
    assert as_text({"Content-Type": "text/javascript; charset=windows-1252"})["Content-Type"] == "text/javascript; charset=utf-8"
    assert as_text({"content-type": "text/css"})["content-type"] == "text/css; charset=utf-8"


def test_what_is_kept_is_bounded_per_response_and_in_total_least_recently_used_first_out():
    responses = ImmutableResponses(max_entry=10, max_total=25)
    key = lambda name: ("x", f"https://x/{name}.js")  # noqa: E731
    assert not responses.put(key("big"), 200, CHUNK, b"x" * 11)
    for name in "abc":
        assert responses.put(key(name), 200, CHUNK, b"x" * 10)
    # Thirty bytes is over 25: the oldest went.
    assert key("a") not in responses
    # Used since, so not the oldest any more.
    responses.get(key("b"))
    responses.put(key("d"), 200, CHUNK, b"x" * 10)
    assert key("b") in responses and key("c") not in responses
