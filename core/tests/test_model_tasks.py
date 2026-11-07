"""The table that says what every model call is for.

These assert the *properties* the table exists to guarantee — one statement of
the mapping, a model never asked for an effort it lacks, and defaults that
reach production — rather than the particular models in it today. A row's model
is a product decision that should be changeable without editing a test.
"""

import pytest

from delphi_core.config import Settings
from delphi_core.model_tasks import (
    MODEL_REASONING_EFFORTS,
    MODEL_TASKS,
    ModelTask,
    _validate_table,
    describe_model_tasks,
)



def settings(**overrides) -> Settings:
    # `_env_file=None` is the whole point: these test the table's defaults, and
    # a developer's own .env must not decide whether they pass.
    return Settings(_env_file=None, web_sandbox_origin="http://sandbox.test", **overrides)


def test_every_task_setting_resolves_to_the_table():
    resolved = settings()
    for task in MODEL_TASKS:
        if task.model_setting:
            assert getattr(resolved, task.model_setting) == task.model, task.key
        if task.effort_setting:
            assert getattr(resolved, task.effort_setting) == task.effort, task.key
        if task.tokens_setting:
            assert getattr(resolved, task.tokens_setting) == task.max_output_tokens


def test_a_stored_digests_model_check_still_matches_what_the_table_resolves():
    # `digest_is_valid` compares digest["model"] == settings.digest_model, so a
    # resolved value that drifts from the table would silently invalidate and
    # rebuild every stored digest in the account.
    table = {task.key: task for task in MODEL_TASKS}["digest.author"]
    assert settings().digest_model == table.model


def test_authoring_and_judging_are_separately_swappable():
    # One model writes, a different configuration judges. They may be pointed
    # at the same model, but never at the same *setting*, or a future change
    # moves both sides of the gate together.
    author = {task.key: task for task in MODEL_TASKS}["memory.maintain"]
    verify = {task.key: task for task in MODEL_TASKS}["memory.verify"]
    assert author.model_setting != verify.model_setting
    assert author.effort_setting != verify.effort_setting


def test_a_model_is_never_asked_for_an_effort_it_does_not_offer():
    for task in MODEL_TASKS:
        assert task.effort in MODEL_REASONING_EFFORTS[task.model], task.key


def test_a_table_row_asking_for_a_rung_its_model_lacks_fails_at_import(monkeypatch):
    impossible = ModelTask(
        "memory.maintain", "…", "gpt-6-sol", "xhigh", 1, False,
        "memory_maintain_model", "memory_maintain_reasoning_effort", "",
    )
    monkeypatch.setattr("delphi_core.model_tasks.MODEL_TASKS", (impossible,))
    with pytest.raises(ValueError, match="does not offer"):
        _validate_table()


def test_two_rows_sharing_a_setting_may_not_disagree_about_it(monkeypatch):
    monkeypatch.setattr(
        "delphi_core.model_tasks.MODEL_TASKS",
        (
            ModelTask("a", "…", "gpt-6-luna", "low", 1, False, "memory_review_model", "", ""),
            ModelTask("b", "…", "gpt-6-sol", "low", 1, False, "memory_review_model", "", ""),
        ),
    )
    with pytest.raises(ValueError, match="disagree"):
        _validate_table()


def test_an_override_is_refused_when_its_model_lacks_the_rung():
    with pytest.raises(ValueError, match="does not offer"):
        settings(memory_maintain_model="gpt-6-sol", memory_maintain_reasoning_effort="xhigh")


def test_the_orchestrator_still_moves_every_unpinned_task():
    # CLAUDE.md tells extenders one env var moves every derived artifact, so it
    # keeps doing that — over the table's defaults, not instead of them.
    moved = settings(orchestrator_model="gpt-6-sol")
    assert moved.digest_model == "gpt-6-sol"
    assert moved.memory_review_model == "gpt-6-sol"


def test_one_task_can_be_pinned_without_moving_the_others():
    pinned = settings(digest_model="gpt-6-sol")
    assert pinned.digest_model == "gpt-6-sol"
    assert pinned.memory_file_select_model == "gpt-6-luna"


def test_the_startup_line_names_every_task():
    described = describe_model_tasks()
    for task in MODEL_TASKS:
        assert task.key in described


def test_the_startup_line_names_the_models_settings_chose_not_the_defaults():
    """A Claude connection logged every task as its gpt default."""
    described = describe_model_tasks(settings(digest_model="gpt-6-sol"))
    assert "digest.author=gpt-6-sol/" in described
    assert "chat.answer=gpt-6.1-sol/" in described


def test_the_retired_filing_tasks_and_their_settings_are_gone():
    """The old pipelines' rows are deleted, not left pointing at settings nothing reads."""
    keys = {task.key for task in MODEL_TASKS}
    assert not keys & {"knowledge.author", "knowledge.verify", "knowledge.ingest_verify"}
    # Lint, re-filing proposals and domain composition still run on this one.
    assert "memory.review" in keys
    resolved = settings()
    for retired in (
        "knowledge_author_model", "knowledge_verifier_model", "knowledge_document_verifier_reasoning_effort",
        "knowledge_combined_authoring_enabled", "knowledge_plan_attempts", "knowledge_render_attempts",
    ):
        assert not hasattr(resolved, retired), retired
