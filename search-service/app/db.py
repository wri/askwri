"""Shared psycopg connection pool with pgvector type adapters registered."""
import logging

from pgvector.psycopg import register_vector
from psycopg_pool import ConnectionPool

from app.config import get_settings

logger = logging.getLogger(__name__)

_pool = None


def _configure(conn):
    register_vector(conn)


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        settings = get_settings()
        if not settings.database_url:
            raise RuntimeError("DATABASE_URL is not set but retrieval_backend/migration requires Postgres")
        _pool = ConnectionPool(
            settings.database_url,
            min_size=1,
            max_size=5,
            configure=_configure,
            open=True,
        )
        logger.info("Postgres connection pool opened")
    return _pool
