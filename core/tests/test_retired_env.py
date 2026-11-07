"""
L9: a setting renamed when Knowledge became Memory refuses its old name.

The old names are literals on purpose: they are what an old `.env` or a
deployment still holds, and each must stop the backend with its replacement
named, rather than be ignored while a default takes its place.
"""

import pytest

from delphi_core.config import RETIRED_ENV, Settings

RETIRED = {
    "KNOWLEDGE_BASE_ENABLED": "MEMORY_ENABLED",
    "KNOWLEDGE_MODEL": "MEMORY_REVIEW_MODEL",
    "KNOWLEDGE_REASONING_EFFORT": "MEMORY_REVIEW_REASONING_EFFORT",
    "KNOWLEDGE_TIMEOUT_SECONDS": "MEMORY_REVIEW_TIMEOUT_SECONDS",
    "KNOWLEDGE_MAX_OUTPUT_TOKENS": "MEMORY_REVIEW_MAX_OUTPUT_TOKENS",
    "KNOWLEDGE_MAX_PAGES": "MEMORY_MAX_PAGES",
    "KNOWLEDGE_DRAIN_WORKERS": "MEMORY_DRAIN_WORKERS",
    "KNOWLEDGE_JOB_MAX_ATTEMPTS": "MEMORY_JOB_MAX_ATTEMPTS",
    "KNOWLEDGE_JOB_LEASE_RENEW_SECONDS": "MEMORY_JOB_LEASE_RENEW_SECONDS",
    "KNOWLEDGE_JOB_LEASE_SECONDS": "MEMORY_JOB_LEASE_SECONDS",
    "KNOWLEDGE_PAGE_MAX_CHARS": "MEMORY_PAGE_MAX_CHARS",
    "KNOWLEDGE_SUMMARY_MAX_CHARS": "MEMORY_SUMMARY_MAX_CHARS",
    "KNOWLEDGE_RELATED_HOPS": "MEMORY_RELATED_HOPS",
    "KNOWLEDGE_TOOL_MAX_CALLS": "MEMORY_TOOL_MAX_CALLS",
    "KNOWLEDGE_GENERAL_TOOL_MAX_CALLS": "MEMORY_GENERAL_TOOL_MAX_CALLS",
    "KNOWLEDGE_FIGURE_MAX_PER_PAGE": "MEMORY_FIGURE_MAX_PER_PAGE",
    "KNOWLEDGE_FIGURE_MAX_SIDE": "MEMORY_FIGURE_MAX_SIDE",
    "KNOWLEDGE_FIGURE_MAX_VIEWS": "MEMORY_FIGURE_MAX_VIEWS",
    "KNOWLEDGE_REWRITE_NOTE_MAX_WORDS": "MEMORY_REWRITE_NOTE_MAX_WORDS",
}


def test_every_renamed_setting_is_listed_with_its_replacement():
    assert RETIRED_ENV == RETIRED
    assert all(new.lower() in Settings.model_fields for new in RETIRED.values())


@pytest.mark.parametrize("old", sorted(RETIRED))
def test_a_retired_name_in_the_environment_stops_the_backend_and_names_its_replacement(monkeypatch, old):
    monkeypatch.setenv(old, "1")
    with pytest.raises(ValueError, match=f"{old} is now {RETIRED[old]}"):
        Settings(_env_file=None)


def test_a_retired_name_in_the_env_file_stops_the_backend_too(tmp_path, monkeypatch):
    for name in RETIRED:
        monkeypatch.delenv(name, raising=False)
    env = tmp_path / ".env"
    env.write_text("KNOWLEDGE_MODEL=some-model\n")
    with pytest.raises(ValueError, match="KNOWLEDGE_MODEL is now MEMORY_REVIEW_MODEL"):
        Settings(_env_file=env)


def test_a_lower_case_retired_name_is_refused_like_any_other(monkeypatch):
    monkeypatch.setenv("knowledge_max_pages", "10")
    with pytest.raises(ValueError, match="KNOWLEDGE_MAX_PAGES is now MEMORY_MAX_PAGES"):
        Settings(_env_file=None)


def test_the_new_names_are_read(tmp_path, monkeypatch):
    for name in RETIRED:
        monkeypatch.delenv(name, raising=False)
    env = tmp_path / ".env"
    env.write_text("MEMORY_REVIEW_MODEL=some-model\nMEMORY_MAX_PAGES=12\n")
    settings = Settings(_env_file=env)
    assert (settings.memory_review_model, settings.memory_max_pages) == ("some-model", 12)
