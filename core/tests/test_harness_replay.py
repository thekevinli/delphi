"""What a stateless next round is handed back: one table, pinned row by row."""

from delphi_core.harness.replay import REPLAY_POLICY, replay_item, replay_items

CITATION = {"type": "url_citation", "url": "https://arxiv.org/abs/1706.03762",
            "title": "Attention Is All You Need", "start_index": 4, "end_index": 50}


def test_reasoning_goes_back_sealed_and_only_sealed():
    sealed = {"type": "reasoning", "id": "rs_1", "summary": [{"type": "summary_text", "text": "Checking"}],
              "encrypted_content": "sealed", "content": []}
    assert replay_item(sealed) == {
        "type": "reasoning", "summary": sealed["summary"], "encrypted_content": "sealed",
    }
    # Without the sealed form there is nothing the provider will accept back.
    assert replay_item({"type": "reasoning", "id": "rs_2", "summary": []}) is None


def test_a_message_keeps_its_text_its_phase_and_its_citations():
    message = {"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
               "phase": "final_answer",
               "content": [{"type": "output_text", "text": "In 2017 (arxiv.org).", "annotations": [CITATION]},
                           {"type": "output_text", "text": "No citation here.", "annotations": []},
                           {"type": "output_text", "text": ""},
                           {"type": "refusal", "refusal": "no"}]}
    assert replay_item(message) == {
        "type": "message", "role": "assistant", "phase": "final_answer",
        "content": [
            # A citation is part of what the model said, so it goes back with it.
            {"type": "output_text", "text": "In 2017 (arxiv.org).", "annotations": [CITATION]},
            # None to keep means no key at all: the request stays what it was.
            {"type": "output_text", "text": "No citation here."},
        ],
    }
    assert replay_item({"type": "message", "content": [{"type": "output_text", "text": ""}]}) is None


def test_a_function_call_goes_back_by_its_call_id():
    call = {"type": "function_call", "id": "fc_1", "status": "completed", "call_id": "call-1",
            "name": "read_paper", "arguments": '{"paper_id": "p", "pages": [3]}'}
    assert replay_item(call) == {
        "type": "function_call", "call_id": "call-1", "name": "read_paper",
        "arguments": '{"paper_id": "p", "pages": [3]}',
    }
    assert replay_item({"type": "function_call", "call_id": "c", "name": "n"})["arguments"] == "{}"


def test_a_completed_hosted_search_goes_back_without_its_id():
    """Left out, the next round runs the same search again (measured: twice the input)."""
    search = {"type": "web_search_call", "id": "ws_1", "status": "completed",
              "action": {"type": "search", "query": "mu parametrization", "queries": ["mu parametrization"],
                         "sources": [{"type": "url", "url": "https://arxiv.org/abs/2203.03466"}]}}
    opened = {"type": "web_search_call", "id": "ws_2", "status": "completed",
              "action": {"type": "open_page", "url": "https://arxiv.org/abs/2203.03466"}}
    assert replay_item(search) == {key: value for key, value in search.items() if key != "id"}
    assert replay_item(opened) == {key: value for key, value in opened.items() if key != "id"}


def test_a_hosted_call_the_allowance_cut_is_left_out():
    cut = {"type": "web_search_call", "id": "ws_3", "status": "searching",
           "action": {"type": "search", "query": "one too many"}}
    assert replay_item(cut) is None


def test_an_item_of_a_type_nobody_measured_is_left_out():
    assert "image_generation_call" not in REPLAY_POLICY
    assert replay_item({"type": "image_generation_call", "id": "ig_1", "status": "completed"}) is None
    assert replay_item({}) is None


def test_a_round_is_handed_back_in_the_order_it_happened():
    output = [
        {"type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "a"},
        {"type": "web_search_call", "id": "ws_1", "status": "completed", "action": {"type": "search", "query": "q"}},
        {"type": "web_search_call", "id": "ws_2", "status": "searching", "action": {"type": "search", "query": "r"}},
        {"type": "reasoning", "id": "rs_2", "summary": []},
        {"type": "function_call", "id": "fc_1", "call_id": "call-1", "name": "open_memory", "arguments": "{}"},
    ]
    assert [item["type"] for item in replay_items(output)] == [
        "reasoning", "web_search_call", "function_call",
    ]
    assert all("id" not in item for item in replay_items(output))
