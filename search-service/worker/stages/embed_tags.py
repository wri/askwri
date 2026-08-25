"""Tag embedding maintenance. tag_embeddings is python-owned (no app entity).

Builds label + " | " + aliases + " — " + description, embeds with cohere-embed-v4,
UPSERTs into tag_embeddings, clears tags.needs_reembed.

Two-writer boundary (per CLAUDE.md): the app owns tags/tag_aliases/reclassify_jobs
(relational); the worker owns tag_embeddings (pgvector, raw SQL, no TypeORM
entity). The app sets tags.needs_reembed=true on edits; this stage clears it
after embedding. App never calls Bedrock; this stage never uses the app's
entities.
"""
import logging

from app.bedrock_embed import embed_one
from app.config import get_settings

logger = logging.getLogger(__name__)

MODEL = "cohere-embed-v4"
DIM = 1536

# Facets that participate in retrieve-then-classify and so carry tag_embeddings.
# program/office/doc_type use the full-enum classify path and are deliberately
# NOT embedded — adding them here would waste Bedrock calls for no reader.
EMBEDDED_FACETS = ("topic", "geography")


def _compose_text(label: str, aliases: list, description: str | None) -> str:
    """Compose the text to embed for a tag.

    label + " | " + aliases (pipe-joined) + " — " + description.
    Only append aliases if non-empty; only append description if non-empty.
    A tag with just a label embeds the label alone.
    """
    parts = label
    if aliases:
        parts = label + " | " + " | ".join(aliases)
    if description:
        parts = parts + " — " + description
    return parts


def embed_tag(conn, tag_id) -> None:
    """Embed a single tag and UPSERT into tag_embeddings. Clears needs_reembed.

    Uses input_type=search_document (via embed_one) so tag embeddings match
    the same input_type as document chunks — making doc↔tag cosine similarity
    meaningful for the retrieve-then-classify stage.
    """
    row = conn.execute(
        """SELECT t.value_id, t.description,
                  COALESCE(
                    (SELECT array_agg(a.alias) FROM tag_aliases a WHERE a.tag_id = t.id),
                    '{}'::text[]
                  )
           FROM tags t WHERE t.id = %s""",
        (tag_id,),
    ).fetchone()
    if not row:
        logger.warning("embed_tag: tag %s not found", tag_id)
        return

    label, description, aliases = row
    text = _compose_text(label, aliases or [], description)
    vec = embed_one(text)

    conn.execute(
        """INSERT INTO tag_embeddings (tag_id, embedding_model, dimension, embedding, embedded_text, embedded_at)
           VALUES (%s, %s, %s, %s, %s, now())
           ON CONFLICT (tag_id, embedding_model) DO UPDATE
           SET embedding = EXCLUDED.embedding,
               embedded_text = EXCLUDED.embedded_text,
               embedded_at = now()""",
        (tag_id, MODEL, DIM, vec, text),
    )
    conn.execute("UPDATE tags SET needs_reembed = false WHERE id = %s", (tag_id,))


def sweep_pending(conn, batch_size: int | None = None) -> int:
    """Sweep tags with needs_reembed=true, embed them, clear the flag.

    Uses the partial index idx_tags_facet_needs_reembed for a cheap scan.
    Returns the number of tags processed.
    """
    n = 0
    bs = batch_size or get_settings().tag_embed_batch_size
    rows = conn.execute(
        """SELECT id FROM tags
           WHERE needs_reembed AND facet = ANY(%s)
           ORDER BY value_id LIMIT %s""",
        (list(EMBEDDED_FACETS), bs),
    ).fetchall()
    for (tag_id,) in rows:
        embed_tag(conn, tag_id)
        n += 1
    if n:
        logger.info("sweep_pending: embedded %d tag(s)", n)
    return n


def build_all_embeddings(conn, batch_size: int | None = None) -> int:
    """One-time/force build: embed all topic tags lacking a row in tag_embeddings.

    Used for the initial 755-topic build and the admin "Rebuild embeddings"
    action (which sets needs_reembed=true on all topic tags, then the sweep
    picks them up — but this function handles the case where tag_embeddings
    rows don't exist at all).
    """
    n = 0
    bs = batch_size or get_settings().tag_embed_batch_size
    rows = conn.execute(
        """SELECT t.id FROM tags t
           WHERE t.facet = ANY(%s) AND t.taxonomy_version = 'v1'
             AND NOT EXISTS (
               SELECT 1 FROM tag_embeddings te WHERE te.tag_id = t.id
             )
           ORDER BY t.value_id LIMIT %s""",
        (list(EMBEDDED_FACETS), bs),
    ).fetchall()
    for (tag_id,) in rows:
        embed_tag(conn, tag_id)
        n += 1
    logger.info("build_all_embeddings: built %d tag embedding(s) (batch %d)", n, bs)
    return n
