from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

# Per-row document_chunks.embedding_model values and their vector dimensions.
# Both models keep scoped HNSW indexes during the cutover window (spec v3 §8.1).
EMBEDDING_DIMENSIONS = {
    "cohere-embed-v4": 1536,
    "text-embedding-3-small": 1536,
}


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    model_config = SettingsConfigDict(env_file=(".env", ".env.local"), env_file_encoding="utf-8", extra="ignore")

    # Application
    environment: str = "development"
    debug: bool = False
    port: int = 8000
    workers: int = 1
    log_level: str = "info"
    
    # Next.js Backend URL for communication
    nextjs_backend_url: str = "http://localhost:3000"

    OPENAI_API_KEY: str = ""

    # Document storage paths (override for local dev, e.g. DOCUMENTS_LOCAL_DIR=./data)
    documents_local_dir: str = "/tmp/askWRI_docs"
    cache_dir: str = "/tmp/askWRI_cache"

    # Postgres-backed retrieval (Phase 0 cutover)
    database_url: str = ""          # postgresql://user:pass@host:5432/db (append ?sslmode=require for RDS)
    retrieval_backend: str = "legacy"  # "legacy" (CSV + boot-time build) | "postgres"

    # Keyword lane residency (postgres retrieval backend only):
    # "sparse" = Postgres-resident BM25 impact vectors in document_chunks.sparse,
    #            filtered per-query (status='searchable'); requires
    #            scripts/build_sparse_keyword.py to have run at least once.
    #            Rollback: set KEYWORD_BACKEND=memory to revert to legacy path.
    # "memory" = in-memory bm25s built at boot//reindex (legacy behavior, kept intact)
    keyword_backend: str = "sparse"  # "sparse" (default) | "memory"

    # Phase 1 ingestion worker
    worker_poll_seconds: int = 10
    worker_max_attempts: int = 3
    worker_reap_minutes: int = 15              # requeue 'running' jobs idle longer than this
    worker_llm_model: str = "gpt-5-mini"      # summaries + tagging; override in env
    intake_s3_prefix: str = "intake/"          # watched S3 prefix (bulk drop)
    intake_local_dir: str = ""                 # local-dev alternative to S3 intake
    documents_s3_bucket: str = ""              # reuse the existing env var name
    documents_s3_prefix: str = "documents/"
    tag_confidence_accept: float = 0.7         # >= -> accepted, else suggested
    quality_min_chars_per_page: int = 200      # extraction_confidence gate input

    # Dense embedding model for BOTH worker chunk writes and query-side
    # retrieval (spec v3 §4: Cohere embed-v4 via Bedrock — an API call, no
    # self-hosted model). The English bm25s sparse lane is independent of
    # this and unchanged. Rollback: EMBEDDING_MODEL=text-embedding-3-small
    # while the 3-small rows/index still exist.
    embedding_model: str = "cohere-embed-v4"

    # PDF parse backend (bake-off 2026-07-22, spec §7 amendment):
    # "pypdf" (legacy text-layer extraction, current default until the
    # Phase 1 retrieval gate passes) | "mistral" (Mistral OCR markdown,
    # per-page emission — parser page indices fix the R4 zh page-boundary
    # bug). pypdf remains the validation oracle either way.
    parse_backend: str = "pypdf"
    mistral_api_key: str = ""
    mistral_ocr_model: str = "mistral-ocr-latest"

    # Bedrock placement for embed-v4 (spec v3 §5): infra is us-east-2 but
    # embed-v4 is not natively there — call the nearest hosting region
    # (cross-region, still in-AWS/IAM).
    bedrock_embed_region: str = "us-east-1"
    bedrock_embed_model_id: str = "cohere.embed-v4:0"
    # Per-call text batch for bulk document embeds (Cohere API cap 96 is the
    # ceiling). Large docs at 96 blow the tokens/min bucket and error whole
    # worker jobs — bulk re-ingests/re-embeds set 24 (with
    # AWS_RETRY_MODE=adaptive).
    bedrock_embed_batch_size: int = 96

    # Bedrock placement for Cohere Rerank 3.5 (spec v3 §5): not hosted in
    # us-east-2 — call the nearest hosting region.
    bedrock_rerank_region: str = "us-west-2"
    bedrock_rerank_model_id: str = "cohere.rerank-v3-5:0"

    # Candidate-set size sent to the Rerank API. Cost/latency scale with doc
    # count (spec §9: rerank dominates the per-query budget) — the fused RRF
    # list is cut to this many before the call.
    rerank_candidates: int = 100

    # Cite-mode candidate diversification: fused chunk lists cluster in a
    # handful of top docs (measured: 100 chunks from 5 docs on the golden
    # set), so cap each doc's chunks in the candidate set to spread the
    # slots across documents. Doc-level recall lever at unchanged API cost.
    # Answer mode is uncapped — it wants the best chunks wherever they live.
    cite_rerank_per_doc_cap: int = 2

    # Cite mode thresholds on Cohere Rerank's 0-1 relevance-score scale
    # (spec v3 §0.1: re-derived, NOT the old ms-marco raw logits — those
    # values, e.g. floor -9.0, would pass everything on this scale).
    # Derived 2026-07-22 from live-Bedrock score capture (11 golden cite
    # queries + 16-query non-EN smoke set, per-doc-capped candidates) and
    # re-derived after EACH corpus change — the floor moves every time the
    # chunk text or embedding model changes (0.08 on the 3-small corpus →
    # 0.10 post-embed-cutover → 0.09 post-Mistral-re-parse, which holds the
    # recall gate at R83.1 with P30.6/F1 44.7). Re-derive with
    # scripts/capture_cite_scores.py + analyze_cite_scores.py after any
    # candidate-pool change; the deployed cutover gets its own derivation.
    # TODO(golden-set): formal per-language floor/tier recalibration.
    cite_logit_floor: float = 0.09        # Drop docs below this relevance score
    cite_strong_threshold: float = 0.70
    cite_partial_threshold: float = 0.30

    # CloudWatch EMF latency metrics: one pure-JSON stdout line per /query
    # with per-stage timings (L0 latency instrumentation). The ECS awslogs
    # driver ships it; CloudWatch parses the embedded metric format.
    emit_emf_metrics: bool = True

    # SSL/Zscaler VPN Workaround
    use_custom_ssl_client: bool = False
    custom_ca_bundle: str = ""

    @property
    def embedding_dimension(self) -> int:
        return EMBEDDING_DIMENSIONS[self.embedding_model]

@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
