# =============================================================================
# Search Service Dockerfile
# =============================================================================

FROM python:3.12-slim as base

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install system dependencies including AWS CLI for S3 sync.
# ghostscript: the parse stage shells out to `gs` to downsample raster images
# in PDFs over Mistral OCR's 50MB hard limit (worker/stages/parse.py
# _shrink_pdf). Without it those documents cannot be parsed at all.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    awscli \
    gcc \
    g++ \
    ghostscript \
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# Dependencies stage
# =============================================================================

FROM base as dependencies

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# No model pre-download: the service is model-free (spec v3) — dense encode
# and rerank are Bedrock API calls (Cohere embed-v4 / Rerank 3.5).

# =============================================================================
# Production stage
# =============================================================================

FROM dependencies as production

# Create non-root user for security
RUN groupadd --gid 1000 appgroup && \
    useradd --uid 1000 --gid appgroup --shell /bin/bash --create-home appuser

# Copy application code
COPY --chown=appuser:appgroup app/ ./app/
COPY --chown=appuser:appgroup worker/ ./worker/

# Copy startup script and make executable (before USER switch)
COPY --chown=appuser:appgroup start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Create documents and cache directories (writable by appuser) - must be before USER switch
RUN mkdir -p /tmp/askWRI_docs /tmp/askWRI_cache && chown appuser:appgroup /tmp/askWRI_docs /tmp/askWRI_cache

# Switch to non-root user
USER appuser

# Expose port
EXPOSE ${PORT:-8000}

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8000}/health || exit 1

# Run the application with optional S3 sync at startup
CMD ["/app/start.sh"]
