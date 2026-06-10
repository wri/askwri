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
            conn.execute("TRUNCATE documents CASCADE")
            conn.execute("TRUNCATE tags CASCADE")
            conn.execute("TRUNCATE collections CASCADE")

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
            title = raw.get("Article Title") or raw.get("Publication Title") or ext_id
            doc_id = uuid.uuid4()

            conn.execute(
                """INSERT INTO documents
                   (id, external_id, doi, s3_key, title, title_en, language, languages,
                    year_published, publication_title, article_type, wri_primary_office,
                    status, source_metadata)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'searchable',%s)""",
                (doc_id, ext_id, raw.get("DOI"), meta.get("file_path") or f"{ext_id}.pdf",
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

            for kind, key in (("long", "summary"), ("short", "short_summary")):
                text = raw.get(key) or (meta.get("summary", "") if kind == "long" else "")
                if text:
                    conn.execute(
                        """INSERT INTO document_summaries (document_id, language, kind, text, source)
                           VALUES (%s,%s,%s,%s,'external')""",
                        (doc_id, language, kind, text),
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
