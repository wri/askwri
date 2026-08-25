"""Confirmed translation-pair lookup for query-time filtering (issue #325).

Only status='confirmed', relation_type='translation_of' edges matter.
Queried per request when translation_pairs_enabled — one indexed SELECT on a
tiny table — so a DMS confirm/unlink takes effect on the next query with no
reindex. Flag off (the default) short-circuits to {} with zero DB work.
"""
import logging

from app.config import get_settings
from app.db import get_pool

logger = logging.getLogger(__name__)

_PAIRS_SQL = """
    SELECT dt.external_id, do_.external_id,
           COALESCE(do_.title_en, do_.title),
           do_.status = 'searchable'
    FROM document_relations r
    JOIN documents dt ON dt.id = r.document_id
    JOIN documents do_ ON do_.id = r.related_document_id
    WHERE r.status = 'confirmed' AND r.relation_type = 'translation_of'
"""


def load_confirmed_pairs() -> dict:
    if not get_settings().translation_pairs_enabled:
        return {}
    out = {}
    with get_pool().connection() as conn:
        for t_ext, o_ext, o_title, o_searchable in conn.execute(_PAIRS_SQL):
            out[t_ext] = {"original": o_ext, "original_title": o_title,
                          "original_searchable": bool(o_searchable)}
    return out
