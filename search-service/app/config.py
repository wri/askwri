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

    # Voyage AI reranker
    VOYAGE_API_KEY: str = ""

    # Document storage paths (override for local dev, e.g. DOCUMENTS_LOCAL_DIR=./data)
    documents_local_dir: str = "/tmp/askWRI_docs"
    cache_dir: str = "/tmp/askWRI_cache"

    # Cite mode reranker thresholds (Voyage 0-1 scores, calibrated 2026-03-21)
    cite_score_floor: float = 0.50       # Calibrating — sweep predicted P=31% R=80% F1=43%
    cite_strong_threshold: float = 0.80  # Top tier
    cite_partial_threshold: float = 0.60 # Mid tier

    # SSL/Zscaler VPN Workaround
    use_custom_ssl_client: bool = False
    custom_ca_bundle: str = ""

@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
