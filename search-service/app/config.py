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

    # Cite mode reranker logit thresholds (calibrated 2026-03-19)
    cite_logit_floor: float = -9.0        # Drop docs below this raw logit
    cite_strong_threshold: float = -2.3   # 70th percentile of relevant scores
    cite_partial_threshold: float = -7.8  # 25th percentile of relevant scores

    # Answer mode reranker logit thresholds (values set after calibration)
    answer_logit_floor: float = -999.0        # disabled until calibrated
    answer_strong_threshold: float = -999.0
    answer_partial_threshold: float = -999.0
    answer_use_logit_floor: bool = False       # gate — flip after calibration validates

    # SSL/Zscaler VPN Workaround
    use_custom_ssl_client: bool = False
    custom_ca_bundle: str = ""

@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
