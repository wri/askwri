"""English handles for the sparse BM25 lane (spec 2026-07-26 §3).

Generalizes the mechanism the corpus already proves: zh docs are reachable by
English queries because every zh chunk carries an English title in its indexed
metadata header (findings 2026-07-24 §2.2); es/pt/id docs carry none. When
SPARSE_EN_HANDLES is on, the two sparse write sites append, per chunk of a
language != 'en' document:

- title_en (skipped when it equals the indexed title after casefold +
  whitespace normalization — zh docs), and
- for the summary chunk only, the curated English long summary
  (document_summaries language='en', kind='long').

SPARSE ONLY. The handle text must never reach the dense-embedding content
string or the stored chunk text — injecting into the shared
get_content(MetadataMode.EMBED) string would silently change dense embeddings
and force a re-embed (spec §3.2 implementation callout).
"""
from typing import Dict

# Mirrors the indexer's title choice (worker/stages/embed.py:76,
# app.indexing load_csv_metadata) so the equality skip compares like to like.
_HANDLES_SQL = """
    SELECT d.external_id,
           COALESCE(NULLIF(d.source_metadata->'metadata'->>'Publication Title', ''),
                    NULLIF(d.source_metadata->'metadata'->>'Article Title', ''),
                    d.title) AS indexed_title,
           d.title_en,
           s.text AS en_summary
    FROM documents d
    LEFT JOIN document_summaries s
      ON s.document_id = d.id AND s.language = 'en' AND s.kind = 'long'
    -- NULL language ⇒ treated as en ⇒ no handles (both sites must agree)
    WHERE COALESCE(d.language, 'en') != 'en'
"""


def _norm(s: str) -> str:
    return " ".join((s or "").casefold().split())


def load_english_handles(conn) -> Dict[str, dict]:
    """{external_id: {indexed_title, title_en, en_summary}} for non-EN docs."""
    out = {}
    for ext, indexed_title, title_en, en_summary in conn.execute(_HANDLES_SQL):
        out[ext] = {
            "indexed_title": indexed_title or "",
            "title_en": title_en or "",
            "en_summary": en_summary or "",
        }
    return out


def handle_text(handle: dict, is_summary_chunk: bool) -> str:
    """The English text to append to ONE chunk's sparse tokenization string."""
    parts = []
    title_en = handle.get("title_en") or ""
    indexed_title = handle.get("indexed_title") or ""
    if title_en and _norm(title_en) != _norm(indexed_title):
        parts.append(title_en)
    if is_summary_chunk and (handle.get("en_summary") or ""):
        parts.append(handle["en_summary"])
    return "\n".join(parts)
