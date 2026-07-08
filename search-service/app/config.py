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

    # Bedrock placement for embed-v4 (spec v3 §5): infra is us-east-2 but
    # embed-v4 is not natively there — call the nearest hosting region
    # (cross-region, still in-AWS/IAM).
    bedrock_embed_region: str = "us-east-1"
    bedrock_embed_model_id: str = "cohere.embed-v4:0"

    # Bedrock placement for Cohere Rerank 3.5 (spec v3 §5): not hosted in
    # us-east-2 — call the nearest hosting region.
    bedrock_rerank_region: str = "us-west-2"
    bedrock_rerank_model_id: str = "cohere.rerank-v3-5:0"

    # Candidate-set size sent to the Rerank API. Cost/latency scale with doc
    # count (spec §9: rerank dominates the per-query budget) — the fused RRF
    # list is cut to this many before the call.
    rerank_candidates: int = 100

    # Cite mode thresholds on Cohere Rerank's 0-1 relevance-score scale
    # (spec v3 §0.1: re-derived, NOT the old ms-marco raw logits — those
    # values, e.g. floor -9.0, would pass everything on this scale).
    # PROVISIONAL conservative (recall-first) values: derive on the
    # non-English smoke set once Bedrock access is wired.
    # TODO(golden-set): formal per-language floor/tier recalibration.
    cite_logit_floor: float = 0.01        # Drop docs below this relevance score
    cite_strong_threshold: float = 0.70
    cite_partial_threshold: float = 0.30

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
