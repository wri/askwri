from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

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

    # Phase 1 ingestion worker
    worker_poll_seconds: int = 10
    worker_max_attempts: int = 3
    worker_llm_model: str = "gpt-5-mini"      # summaries + tagging; override in env
    intake_s3_prefix: str = "intake/"          # watched S3 prefix (bulk drop)
    intake_local_dir: str = ""                 # local-dev alternative to S3 intake
    documents_s3_bucket: str = ""              # reuse the existing env var name
    documents_s3_prefix: str = "documents/"
    tag_confidence_accept: float = 0.7         # >= -> accepted, else suggested
    quality_min_chars_per_page: int = 200      # extraction_confidence gate input

    # Cite mode reranker logit thresholds (calibrated 2026-03-19)
    cite_logit_floor: float = -9.0        # Drop docs below this raw logit
    cite_strong_threshold: float = -2.3   # 70th percentile of relevant scores
    cite_partial_threshold: float = -7.8  # 25th percentile of relevant scores

    # Answer mode reranker model (swap for benchmarking)
    answer_reranker_model: str = "cross-encoder/ms-marco-MiniLM-L-12-v2"  # 33M params, 2x depth vs L-6

    # Reranker inference backend: "onnx" for Fargate (fast CPU), "torch" for local dev (Mac Accelerate)
    reranker_backend: str = "onnx"

    # SSL/Zscaler VPN Workaround
    use_custom_ssl_client: bool = False
    custom_ca_bundle: str = ""

@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
