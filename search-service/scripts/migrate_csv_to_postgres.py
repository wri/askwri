#!/usr/bin/env python3
"""One-time migration: documents.csv + parse/embedding caches -> Postgres.

Prereqs: schema migrated (npm run migration:run), DATABASE_URL set,
documents + caches staged (see docs/plans/2026-06-09-phase0-store-and-migration-plan.md Task 7).

Usage:  cd search-service && ./venv/bin/python -m scripts.migrate_csv_to_postgres [--reset]
"""
import argparse
import json
import pickle
import sys
import uuid
from pathlib import PurePosixPath

import numpy as np
from psycopg.types.json import Jsonb

from app.cache_system import AskWRICache
from app.config import get_settings
from app.db import get_pool
from app.indexing import build_nodes, load_csv_metadata, prepare_documents

EMBEDDING_MODEL = "text-embedding-3-small"
DIMENSION = 1536
COLLECTION_SLUG = "legacy-transport-decarb"
LANGUAGE_MAP = {"english": "en", "spanish": "es", "portuguese": "pt", "chinese": "zh"}
FACETS = [  # (facet, raw metadata key)
    ("program", "wri_programs"),
    ("office", "wri_primary_office"),
    ("topic", "Sub-tag"),
    ("doc_type", "article_type"),
]
# Junk sentinels in the CSV "Article Title" field that should NOT become the
# stored title. The migration prefers "Publication Title" when "Article Title"
# is one of these (or empty). 34 docs carry "Pre-EM" and 3 carry "Not available"
# in Article Title while having a real Publication Title.
JUNK_TITLES = {"Pre-EM", "Not available", "", None}


def _title(raw, ext_id):
    """Prefer Publication Title; fall back to Article Title; then external_id.

    The CSV's Article Title is a junk sentinel ("Pre-EM", "Not available") for
    37 docs that have a perfectly good Publication Title. The old fallback
    `raw.get("Article Title") or ...` picked the non-empty junk and never
    reached Publication Title. Prefer Publication Title unless it is itself junk.
    """
    pub = raw.get("Publication Title")
    if pub and pub not in JUNK_TITLES:
        return pub
    art = raw.get("Article Title")
    if art and art not in JUNK_TITLES:
        return art
    return ext_id


def map_languages(raw: str):
    """'English; Spanish' -> ('en', ['en','es']). Unknown labels are logged and kept out."""
    if not raw or not isinstance(raw, str):
        return "en", ["en"]
    parts = [p.strip().lower() for p in raw.replace(";", ",").split(",") if p.strip()]
    codes = [LANGUAGE_MAP[p] for p in parts if p in LANGUAGE_MAP]
    unknown = [p for p in parts if p not in LANGUAGE_MAP]
    if unknown:
        print(f"  ! unmapped language labels {unknown!r} (raw={raw!r}) — defaulting to en")
    if not codes:
        codes = ["en"]
    return codes[0], codes


def parse_year(raw):
    try:
        return int(str(raw).strip()[:4])
    except (TypeError, ValueError):
        return None


def s3_key_for(file_path, ext_id: str, prefix: str) -> str:
    """Build documents.s3_key, which carries the configured documents prefix.

    Readers use s3_key verbatim — worker/stages/parse.py and the PDF routes all
    call get_object(Key=s3_key) with no prefix of their own, and the ECS task
    role only grants s3:GetObject on <bucket>/documents/*. A bare filename here
    therefore resolves to a nonexistent object at the bucket root, which S3
    reports as AccessDenied (not NoSuchKey) because the role's s3:ListBucket
    grant is conditioned on s3:prefix.

    Only the basename is kept, matching mapRowToDocument in
    src/db/queries/importDocuments.ts and keeping a crafted CSV file_path from
    reaching across prefixes.
    """
    raw = file_path if isinstance(file_path, str) else ""  # pandas gives NaN for empty cells
    base = PurePosixPath(raw.strip()).name or f"{ext_id}.pdf"
    return f"{prefix}{base}"


def load_embeddings(cache: AskWRICache, nodes, content_hash: str) -> dict:
    """{node_id: vector}. Prefers the production embeddings.pkl; falls back to
    default__vector_store.json (LlamaIndex SimpleVectorStore format); embeds only misses."""
    emb = {}
    pkl = cache.indexes_dir / f"{content_hash}_vector_index" / "embeddings.pkl"
    if pkl.exists():
        with open(pkl, "rb") as f:
            emb = pickle.load(f)
        print(f"Loaded {len(emb)} cached embeddings from {pkl}")
    else:
        # Fall back to LlamaIndex SimpleVectorStore JSON (embedding_dict key)
        vector_store_json = cache.indexes_dir / f"{content_hash}_vector_index" / "default__vector_store.json"
        if vector_store_json.exists():
            print(f"embeddings.pkl not found; loading from {vector_store_json} ...")
            with open(vector_store_json) as f:
                vs = json.load(f)
            embedding_dict = vs.get("embedding_dict", {})
            emb = {k: v for k, v in embedding_dict.items()}
            print(f"Loaded {len(emb)} cached embeddings from default__vector_store.json")

    missing = [n for n in nodes if n.node_id not in emb]
    if missing:
        print(f"Embedding {len(missing)} nodes via OpenAI ({EMBEDDING_MODEL})...")
        from llama_index.core.schema import MetadataMode
        from llama_index.embeddings.openai import OpenAIEmbedding

        embedder = OpenAIEmbedding(model=EMBEDDING_MODEL)
        # MetadataMode.EMBED matches what VectorStoreIndex embeds (metadata + text).
        texts = [n.get_content(metadata_mode=MetadataMode.EMBED) for n in missing]
        vectors = embedder.get_text_embedding_batch(texts, show_progress=True)
        emb.update({n.node_id: v for n, v in zip(missing, vectors)})
    return emb


def upsert_tag(conn, facet: str, value: str):
    row = conn.execute(
        "SELECT id FROM tags WHERE facet=%s AND value_id=%s AND taxonomy_version='v1'",
        (facet, value),
    ).fetchone()
    if row:
        return row[0]
    tag_id = uuid.uuid4()
    conn.execute(
        "INSERT INTO tags (id, facet, value_id, taxonomy_version) VALUES (%s,%s,%s,'v1')",
        (tag_id, facet, value),
    )
    return tag_id


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reset", action="store_true", help="wipe documents (cascades) and reload")
    args = parser.parse_args()

    settings = get_settings()
    cache = AskWRICache(cache_dir=settings.cache_dir)

    print("1/4 Loading CSV + parsing documents (cache-first)...")
    documents_metadata = load_csv_metadata(settings.documents_local_dir)
    if not documents_metadata:
        sys.exit(f"No documents.csv under {settings.documents_local_dir}")
    documents = prepare_documents(documents_metadata, cache, settings.documents_local_dir)
    print(f"   {len(documents)} documents prepared")

    print("2/4 Building nodes (must match production chunking)...")
    nodes, content_hash = build_nodes(documents, cache)
    print(f"   {len(nodes)} nodes, content_hash={content_hash}")

    print("3/4 Resolving embeddings...")
    embeddings = load_embeddings(cache, nodes, content_hash)

    print("4/4 Writing to Postgres...")
    # BM25 breaks score ties by corpus position, so each chunk records its
    # position in the legacy node build order (corpus_order) for parity.
    corpus_order = {n.node_id: i for i, n in enumerate(nodes)}
    nodes_by_doc = {}
    for n in nodes:
        nodes_by_doc.setdefault(n.metadata["doc_id"], []).append(n)

    with get_pool().connection() as conn:
        existing = conn.execute("SELECT count(*) FROM documents").fetchone()[0]
        if existing and not args.reset:
            sys.exit(f"documents table already has {existing} rows; rerun with --reset to reload")
        if args.reset:
            # Wipe the tables the migration script owns/reloads, preserving
            # ingestion_jobs and audit_log. We CANNOT use `TRUNCATE documents
            # CASCADE` — CASCADE reaches ingestion_jobs (destroying in-flight
            # worker jobs) and audit_log. But `DELETE FROM documents` also
            # reaches ingestion_jobs: migration 178130 set that FK to ON DELETE
            # CASCADE (not SET NULL). So we must detach the jobs first (null
            # their document_id) BEFORE deleting documents, then the DELETE
            # leaves the job rows intact (orphaned, but the worker reaper / a
            # re-enqueue will reattach them). Order: detach jobs → delete
            # children → delete parents.
            conn.execute("UPDATE ingestion_jobs SET document_id = NULL WHERE document_id IS NOT NULL")
            conn.execute("DELETE FROM document_chunks")
            conn.execute("DELETE FROM document_texts")
            conn.execute("DELETE FROM document_summaries")
            conn.execute("DELETE FROM document_tags")
            conn.execute("DELETE FROM document_collections")
            conn.execute("DELETE FROM documents")
            conn.execute("DELETE FROM tags")
            conn.execute("DELETE FROM collections")

        collection_id = uuid.uuid4()
        conn.execute(
            """INSERT INTO collections (id, name, slug, description, owner, language_policy)
               VALUES (%s, %s, %s, %s, 'system', %s)""",
            (collection_id, "Legacy transport decarbonization corpus", COLLECTION_SLUG,
             "All documents migrated from documents.csv on cutover", Jsonb({"primary": "en", "index_native": True})),
        )

        n_chunks = 0
        for doc in documents:
            ext_id = doc["doc_id"]
            meta = doc["metadata"]
            raw = meta.get("raw_metadata", {})
            language, languages = map_languages(raw.get("languages", ""))
            title = _title(raw, ext_id)
            doc_id = uuid.uuid4()

            conn.execute(
                """INSERT INTO documents
                   (id, external_id, doi, s3_key, title, title_en, language, languages,
                    year_published, publication_title, article_type, wri_primary_office,
                    status, source_metadata)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'searchable',%s)""",
                (doc_id, ext_id, raw.get("DOI"),
                 s3_key_for(meta.get("file_path"), ext_id, settings.documents_s3_prefix),
                 title, title if language == "en" else None, language, languages,
                 parse_year(raw.get("YEAR published")), raw.get("Publication Title"),
                 raw.get("article_type"), raw.get("wri_primary_office"),
                 Jsonb({"file_path": meta.get("file_path", ""),
                        "summary": meta.get("summary", "") or "",
                        "metadata": raw})),
            )

            conn.execute(
                """INSERT INTO document_texts (document_id, full_text, page_boundaries, char_count)
                   VALUES (%s,%s,%s,%s)""",
                (doc_id, doc["text"], Jsonb(meta.get("page_boundaries", [])), len(doc["text"])),
            )

            # The legacy pipeline wrote every CSV summary in English, including
            # the ones for non-English documents, so they belong in the 'en'
            # slot rather than the document's own language. Filing them under
            # `language` would park English prose in the native slot where
            # summarize.py can never replace it (source='external' is protected
            # by the precedence rules in worker/stages/summarize.py) and would
            # leave the 'en' slot empty for the very documents that need it.
            for kind, key in (("long", "summary"), ("short", "short_summary")):
                text = raw.get(key) or (meta.get("summary", "") if kind == "long" else "")
                if text:
                    conn.execute(
                        """INSERT INTO document_summaries (document_id, language, kind, text, source)
                           VALUES (%s,'en',%s,%s,'external')""",
                        (doc_id, kind, text),
                    )

            for facet, key in FACETS:
                value = raw.get(key)
                if value and isinstance(value, str) and value.strip():
                    tag_id = upsert_tag(conn, facet, value.strip())
                    conn.execute(
                        """INSERT INTO document_tags (document_id, tag_id, source, confidence, status)
                           VALUES (%s,%s,'external',1.0,'accepted') ON CONFLICT DO NOTHING""",
                        (doc_id, tag_id),
                    )

            conn.execute(
                "INSERT INTO document_collections (document_id, collection_id, added_by) VALUES (%s,%s,'system')",
                (doc_id, collection_id),
            )

            for node in nodes_by_doc.get(ext_id, []):
                vector = embeddings.get(node.node_id)
                if vector is None:
                    sys.exit(f"No embedding for node {node.node_id} ({node.metadata.get('chunk_id')})")
                is_summary = bool(node.metadata.get("is_summary_node"))
                conn.execute(
                    """INSERT INTO document_chunks
                       (document_id, legacy_chunk_id, chunk_index, unit_type, page, text,
                        language, node_metadata, embedding, embedding_model, dimension,
                        corpus_order)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (doc_id, node.metadata["chunk_id"], node.metadata.get("chunk_index", 0),
                     "summary" if is_summary else "text", node.metadata.get("page"),
                     node.text, language, Jsonb(dict(node.metadata)),
                     np.array(vector, dtype=np.float32), EMBEDDING_MODEL, DIMENSION,
                     corpus_order[node.node_id]),
                )
                n_chunks += 1

        conn.execute(
            """INSERT INTO audit_log (source, action, entity_type, after)
               VALUES ('system','import','documents',%s)""",
            (Jsonb({"reason": "phase0 CSV migration", "documents": len(documents),
                    "chunks": n_chunks, "content_hash": content_hash}),),
        )

    print(f"Done: {len(documents)} documents, {n_chunks} chunks.")


if __name__ == "__main__":
    main()
