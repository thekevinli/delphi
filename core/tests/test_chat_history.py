import pytest

from delphi_core.chat_history import complete_exchanges, history_input
from delphi_core.routers.chat import build_responses_input
from delphi_core.schemas import ChatRequest


def exchange(number):
    return [
        {"role": "user", "content": f"question {number}", "requestId": str(number)},
        {"role": "assistant", "content": f"answer {number}", "requestId": str(number), "trace": "private trace"},
    ]


@pytest.mark.parametrize("scope", ["general", "document"])
def test_all_scopes_attach_ten_whole_exchanges(scope):
    history = [message for index in range(12) for message in exchange(index)]
    history.append({"role": "user", "content": "unfinished", "requestId": "pending"})
    result = build_responses_input([], history, ChatRequest(prompt="now", scope=scope))
    text = [item for item in result if isinstance(item.get("content"), str)]
    assert text[:-1] == history_input(history)
    assert len(text[:-1]) == 20
    assert text[0]["content"] == "question 2"
    assert text[-2]["content"] == "answer 11"
    assert all(set(item) == {"role", "content"} for item in text)


def test_pairing_handles_interleaving_cancellation_and_duplicates():
    one, two = exchange(1), exchange(2)
    messages = [one[0], two[0], one[1], two[1], one[1]]
    assert complete_exchanges(messages) == [*one, *two]
    messages += [*exchange(3)[:1], {**exchange(3)[1], "cancelled": True}]
    # Nothing without a requestId ever pairs — a stored message from before
    # request ids existed is debris, not history.
    messages += [{"role": "assistant", "content": "orphan"},
                 {"role": "user", "content": "unkeyed", "selectedText": "the referent"},
                 {"role": "assistant", "content": "unkeyed answer"}]
    result = history_input(messages)
    assert len(result) == 4
    assert "the referent" not in str(result)
    assert "orphan" not in str(result) and "answer 3" not in str(result)


def test_an_edited_question_never_recovers_the_removed_answer():
    messages = [*exchange(1), {"role": "user", "content": "edited", "requestId": "new"}]
    assert complete_exchanges(messages) == exchange(1)
