"""Rebuild search_vocab (trigram did-you-mean vocabulary).

Sources: searchable document titles (title + title_en), topic tag labels,
tag aliases. UNSTEMMED words — keyword_vocab is Snowball-stemmed and
useless for display-quality suggestions. Delete-then-insert: idempotent.

Run: cd search-service && ./venv/bin/python -m scripts.build_search_vocab
"""
import logging
import re

from app.db import get_pool

logger = logging.getLogger(__name__)

_WORD_RE = re.compile(r"[a-zA-Z][a-zA-Z-]{2,}")

# Precedence when a term appears in several sources (title wins: it is the
# vocabulary users actually see).
_PRECEDENCE = {"title": 0, "tag": 1, "alias": 2}


def _words(text: str) -> list[str]:
    return [w.lower().strip("-") for w in _WORD_RE.findall(text or "") if len(w.strip("-")) >= 3]


def collect_terms(titles, tags, aliases) -> dict:
    """(rows of 1-tuples per source) -> {term: (source, df)} — pure."""
    vocab: dict = {}
    for source, rows in (("title", titles), ("tag", tags), ("alias", aliases)):
        for (text,) in rows:
            for w in _words(text):
                if w in vocab:
                    old_source, df = vocab[w]
                    keep = old_source if _PRECEDENCE[old_source] <= _PRECEDENCE[source] else source
                    vocab[w] = (keep, df + 1)
                else:
                    vocab[w] = (source, 1)
    return vocab


def run() -> int:
    with get_pool().connection() as conn:
        titles = conn.execute(
            """SELECT title FROM documents WHERE status = 'searchable' AND title IS NOT NULL
               UNION ALL
               SELECT title_en FROM documents WHERE status = 'searchable' AND title_en IS NOT NULL"""
        ).fetchall()
        tags = conn.execute(
            "SELECT value_id FROM tags WHERE facet = 'topic'"
        ).fetchall()
        aliases = conn.execute("SELECT alias FROM tag_aliases").fetchall()

        vocab = collect_terms(titles, tags, aliases)

        conn.execute("DELETE FROM search_vocab")
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO search_vocab (term, source, df) VALUES (%s, %s, %s)",
                [(t, s, d) for t, (s, d) in vocab.items()],
            )
    logger.info(f"search_vocab rebuilt: {len(vocab)} terms")
    return len(vocab)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run()
