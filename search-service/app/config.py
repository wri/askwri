from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

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

    # Cite mode reranker RAW-LOGIT thresholds for bge-reranker-v2-m3.
    # Interim-calibrated 2026-07-07 on the non-English smoke set + en probes
    # against the local corpus (relevant per-doc max 0.05..7.4 — the low tail
    # is cross-lingual en→zh; distractor per-doc max p50=-8.5, p90=-5.3).
    # Conservative (recall-first): floor sits 5 logits below the weakest
    # observed relevant. TODO(golden-set): formal per-language floor/tier
    # recalibration when the labeled golden set lands.
    cite_logit_floor: float = -5.0        # Drop docs below this raw logit
    cite_strong_threshold: float = 4.0    # ~median of relevant best-doc logits (p~0.98)
    cite_partial_threshold: float = 0.0   # sigmoid midpoint: model says >=50% relevant

    # Mode rerankers (swap for benchmarking). bge-reranker-v2-m3 is the
    # multilingual default (en/zh/es/pt) — the prior English-only ms-marco
    # cross-encoders scored non-English pairs into the cite floor.
    answer_reranker_model: str = "BAAI/bge-reranker-v2-m3"
    cite_reranker_model: str = "BAAI/bge-reranker-v2-m3"

    # Reranker inference backend: "onnx" for Fargate (fast CPU), "torch" for local dev (Mac Accelerate)
    reranker_backend: str = "onnx"

    # Pre-exported ONNX dir (onnx backend only). The fp32 on-the-fly ONNX
    # export of bge-reranker-v2-m3 is >2GB and fails to load (onnxruntime
    # external-data limitation), so the Docker image exports + int8-quantizes
    # at build time and points this at the result. Empty = load by model id.
    reranker_onnx_dir: str = ""
    reranker_onnx_file: str = "model_quantized.onnx"

    # SSL/Zscaler VPN Workaround
    use_custom_ssl_client: bool = False
    custom_ca_bundle: str = ""

@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
