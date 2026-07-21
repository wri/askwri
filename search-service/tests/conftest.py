"""Shared pytest fixtures and helpers for search-service tests.

Loads .env.local then .env from the search-service directory early so that
DATABASE_URL and other vars are available for skip markers evaluated at
collection time.

Loud-skip guard: if REQUIRE_DB_TESTS=1 and DATABASE_URL is missing, fail
loudly instead of silently skipping — prevents false-green CI.
"""
import os

import pytest

# Load .env.local then .env before any skip markers are evaluated — this file
# is imported by pytest before test modules are collected. See app/env.py for
# the precedence rules.
from app.env import load_env

load_env()


def _check_db_required():
    """Call at module level in DB-dependent test files."""
    require = os.getenv("REQUIRE_DB_TESTS") == "1"
    has_url = bool(os.getenv("DATABASE_URL"))
    if require and not has_url:
        pytest.fail(
            "REQUIRE_DB_TESTS=1 but DATABASE_URL is not set. "
            "Set DATABASE_URL or unset REQUIRE_DB_TESTS to allow skips.",
            pytrace=False,
        )


requires_db = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="DATABASE_URL not set (needs migrated Postgres)",
)
