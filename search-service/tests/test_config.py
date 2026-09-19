"""Settings model robustness — boot must not crash on undeclared env vars.

Regression test for finding B3 (surfaced 2026-07-01 by running the pr-check matrix
locally against a real .env):

    search-service/.env contained VOYAGE_API_KEY (a leftover from the parallel
    Voyage-reranker draft branch), but app/config.py's Settings (pydantic-settings
    v2) forbids undeclared fields by default. get_settings() raised
    `ValidationError: voyage_api_key: Extra inputs are not permitted`, which
    crashes the search-service AND the ingestion worker at boot.

CI never caught this because .env is gitignored — pr-check only sets
DATABASE_URL/REQUIRE_DB_TESTS, so the PR goes green while the deploy bricks
both services whenever an undeclared env var is present in the task-def env
(the runbook's SEARCH_SERVICE_ENV / INGESTION_WORKER_ENV secret JSONs land as
plain-text task-def env vars).

The fix is for Settings to IGNORE unknown env vars (the standard
pydantic-settings pattern for "the environment may carry vars for other
services / future features"). This is intentionally a defensive,
feature-agnostic fix: a parallel draft PR wires the Voyage reranker for real
and will declare `voyage_api_key` on its own — this test must NOT depend on
that field existing or not existing, only on "undeclared vars don't crash
boot."

These tests deliberately set/unset env vars and clear the get_settings LRU
cache; they need no database.
"""
import os

import pytest

from app.config import get_settings


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    """get_settings is @lru_cache'd; clear before and after each test so env
    mutations take effect and don't leak across tests."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _purge_unknown_env(monkeypatch, name):
    """Remove an env var if present (monkeypatch can't del a real os.environ
    key it didn't set, so do it directly and restore via the fixture)."""
    if name in os.environ:
        monkeypatch.delenv(name, raising=False)


def test_b3_settings_boot_ignores_undeclared_env_var(monkeypatch):
    """The B3 regression: an undeclared env var in the environment must NOT
    crash Settings() / get_settings().

    Reproduces the VOYAGE_API_KEY condition without depending on that specific
    field (the Voyage draft PR will declare it; the point is that ANY unknown
    var must be tolerated, not just this one).
    """
    _purge_unknown_env(monkeypatch, "VOYAGE_API_KEY")
    monkeypatch.setenv("VOYAGE_API_KEY", "pa-ka_dummy-not-a-real-key")
    # Must not raise.
    settings = get_settings()
    # A known field still parses normally.
    assert settings.retrieval_backend in ("legacy", "postgres")


def test_b3_settings_boot_ignores_arbitrary_undeclared_env_var(monkeypatch):
    """Generalize: any made-up env var name is tolerated, not just the Voyage
    one. Guards against a future 'fix' that special-cases VOYAGE_API_KEY
    instead of setting extra='ignore'."""
    _purge_unknown_env(monkeypatch, "SOME_FUTURE_FEATURE_API_KEY")
    monkeypatch.setenv("SOME_FUTURE_FEATURE_API_KEY", "whatever")
    get_settings()  # must not raise


def test_b3_known_fields_still_validate(monkeypatch):
    """Sanity: declared fields still bind from env. The fix (extra='ignore')
    must not silently swallow real config — only unknown keys."""
    monkeypatch.setenv("RETRIEVAL_BACKEND", "postgres")
    monkeypatch.setenv("KEYWORD_BACKEND", "memory")
    settings = get_settings()
    assert settings.retrieval_backend == "postgres"
    assert settings.keyword_backend == "memory"


# --- Issue #323: topic tagging config defaults ---


def test_topic_tagging_settings_defaults():
    """All 5 new topic-tagging fields have correct defaults."""
    s = get_settings()
    assert s.tag_candidate_top_n == 20
    assert s.tag_reclassify_concurrency == 4
    assert s.tag_embed_batch_size == 100
    assert s.classify_topic_only is False
    assert s.reclassify_poll_first is True
