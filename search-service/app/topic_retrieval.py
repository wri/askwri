"""Topic-tag retrieval lane source (P2.5 Task 1).

Turns semantic tag matches (topic_sense.nearby_topics() output) into
NodeWithScore[] for RRF fusion. For each matched tag (label, cosine), looks
up the docs tagged with it, scores each doc's representative chunk by
cosine × tag_confidence, dedups across tags (max score wins), ranks, caps
at top_k. Failure-soft: any DB error → [] (the lane drops; the fusion
layer records it in degraded_lanes).
"""
import logging
import time

from llama_index.core.retrievers import BaseRetriever
from llama_index.core.schema import NodeWithScore, QueryBundle, TextNode

logger = logging.getLogger(__name__)

# Per-tag docs-by-tag → representative chunk (highest chunk_index).
# document_tags.confidence exists (migration 1781280000000-Migration.ts).
# The column is `chunk_index` (NOT `chunk_idx`); the brief used the wrong name.
_DOC_BY_TAG_SQL = """
    SELECT dc.legacy_chunk_id, dc.text, dc.node_metadata,
           %(cosine)s * COALESCE(dt.confidence, 1.0) AS score
    FROM tags t
    JOIN document_tags dt ON dt.tag_id = t.id
    JOIN documents d ON d.id = dt.document_id
    JOIN document_chunks dc ON dc.document_id = d.id
    WHERE t.facet = 'topic' AND t.value_id = %(label)s
      AND d.status = 'searchable'
      AND dc.chunk_index = (
          SELECT MAX(chunk_index) FROM document_chunks WHERE document_id = d.id
      )
"""

# When weight_by_confidence=False, score by cosine only.
_DOC_BY_TAG_SQL_NO_CONF = """
    SELECT dc.legacy_chunk_id, dc.text, dc.node_metadata,
           %(cosine)s AS score
    FROM tags t
    JOIN document_tags dt ON dt.tag_id = t.id
    JOIN documents d ON d.id = dt.document_id
    JOIN document_chunks dc ON dc.document_id = d.id
    WHERE t.facet = 'topic' AND t.value_id = %(label)s
      AND d.status = 'searchable'
      AND dc.chunk_index = (
          SELECT MAX(chunk_index) FROM document_chunks WHERE document_id = d.id
      )
"""


class TopicTagRetriever(BaseRetriever):
    """Semantic topic lane: for each matched tag (label, cosine), retrieve
    the docs tagged with it, score = cosine × tag_confidence. Dedup docs
    across tags (max score wins). Failure-soft: DB error -> [] (lane drops).
    """

    def __init__(self, nearby_topics, pool, weight_by_confidence: bool = True,
                 top_k: int | None = None, **kwargs):
        super().__init__(**kwargs)
        self._nearby = nearby_topics        # list[(label, cosine)]
        self._pool = pool                   # psycopg pool (get_pool())
        self._weight_by_confidence = weight_by_confidence
        self._top_k = top_k
        self.db_ms = 0.0  # match PgVectorRetriever/SparseKeywordRetriever pattern

    def _retrieve(self, query_bundle: QueryBundle) -> list[NodeWithScore]:
        if not self._nearby:
            return []
        sql = _DOC_BY_TAG_SQL if self._weight_by_confidence else _DOC_BY_TAG_SQL_NO_CONF
        # Dedup by legacy_chunk_id, max score wins (first hit kept).
        by_id: dict[str, NodeWithScore] = {}
        t0 = time.time()
        try:
            with self._pool.connection() as conn:
                for label, cosine in self._nearby:
                    rows = conn.execute(
                        sql, {"label": label, "cosine": cosine}
                    ).fetchall()
                    for legacy_id, text, meta, score in rows:
                        score_f = float(score)
                        cur = by_id.get(legacy_id)
                        if cur is None or score_f > cur.score:
                            by_id[legacy_id] = NodeWithScore(
                                node=TextNode(id_=legacy_id, text=text, metadata=meta),
                                score=score_f,
                            )
        except Exception as exc:  # noqa: BLE001 — never fail a search on the topic lane
            logger.warning(f"topic retrieval lane degraded: {exc}")
            self.db_ms = round((time.time() - t0) * 1000, 1)
            return []
        self.db_ms = round((time.time() - t0) * 1000, 1)
        results = sorted(by_id.values(), key=lambda n: n.score, reverse=True)
        if self._top_k is not None:
            results = results[: self._top_k]
        return results
