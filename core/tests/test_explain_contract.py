"""The explanation contract: where a chat answer's instructions carry it, and where they do not."""

import re

import pytest

from delphi_core.config import Settings
from delphi_core.harness.explain_contract import EVIDENCE_SCOPE, EXPLANATION_CONTRACT, FULL_EXPLANATION_SCOPE
from delphi_core.harness.prompts import EVIDENCE_REQUIREMENTS, PRESENTATION_DEFAULTS
from delphi_core.routers.chat import build_responses_payload
from delphi_core.schemas import ChatRequest


def instructions(body: ChatRequest) -> str:
    sources = [({"id": "paper", "title": "Paper"}, "file-paper")] if body.scope == "document" else []
    return build_responses_payload(
        settings=Settings(_env_file=None), username="reader", project_id="project", project_skills="",
        sources=sources, previous_messages=[], body=body, persona={"content": "PERSONA-SENTINEL"},
    )["instructions"]


@pytest.mark.parametrize("scope", ["document", "general"])
def test_the_contract_comes_after_the_persona_and_each_scope_sentence_after_its_section(scope):
    text = instructions(ChatRequest(scope=scope, prompt="Explain this paper.", **({"paper_id": "paper"} if scope == "document" else {})))
    # Last, so a persona's preference for depth cannot outrank its length and shape.
    assert text.endswith(f"<persona>\nPERSONA-SENTINEL\n</persona>\n\n{EXPLANATION_CONTRACT}")
    assert f"{EVIDENCE_REQUIREMENTS}\n\n{EVIDENCE_SCOPE}\n\n" in text
    assert f"{PRESENTATION_DEFAULTS}\n\n{FULL_EXPLANATION_SCOPE}\n\n" in text


def test_the_contract_names_no_paper_the_evaluation_asks_about():
    targets = ("GRPO", "DiffusionNFT", "PPO", "PagedAttention", "DDIM", "DDPM", "classifier-free guidance", "LoRA",
               "Medusa", "KTO", "Chinchilla", "ViT", "MAE", "CLIP", "RoPE", "DiT", "Decision Transformer",
               "InstructGPT", "ResNet", "Switch Transformer", "flow matching")
    assert [term for term in targets if re.search(rf"\b{re.escape(term)}\b", EXPLANATION_CONTRACT, re.I)] == []


def test_a_plan_turn_goes_without_it():
    plan = ChatRequest(scope="general", prompt="Plan an experiment.", mode="plan")
    plan._plan = {"token": "test-token"}
    text = instructions(plan)
    assert "PERSONA-SENTINEL" in text
    for part in (EXPLANATION_CONTRACT, EVIDENCE_SCOPE, FULL_EXPLANATION_SCOPE):
        assert part not in text


@pytest.mark.parametrize("scope", ["document", "general"])
def test_the_desktop_plan_mode_goes_without_it(scope):
    # The desktop's Plan never sends `mode="plan"`: it keeps its own protocol and says so here.
    plan = ChatRequest(scope=scope, prompt="Plan an experiment.", disable_explanation_contract=True,
                       **({"paper_id": "paper"} if scope == "document" else {}))
    text = instructions(plan)
    assert "PERSONA-SENTINEL" in text
    for part in (EXPLANATION_CONTRACT, EVIDENCE_SCOPE, FULL_EXPLANATION_SCOPE):
        assert part not in text


def test_a_side_chat_explains_as_a_main_turn_does():
    side = ChatRequest(scope="document", prompt="And this?", paper_id="paper")
    side._side = []
    text = instructions(side)
    assert "# This is a side chat" in text and "Keep answers short" not in text
    for part in (EXPLANATION_CONTRACT, EVIDENCE_SCOPE, FULL_EXPLANATION_SCOPE):
        assert part in text
    assert text.index("PERSONA-SENTINEL") < text.index(EXPLANATION_CONTRACT)
