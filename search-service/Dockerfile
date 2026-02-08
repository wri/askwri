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

# Install system dependencies including AWS CLI for S3 sync
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    awscli \
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# Dependencies stage
# =============================================================================

FROM base as dependencies

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# =============================================================================
# Production stage
# =============================================================================

FROM dependencies as production

# Create non-root user for security
RUN groupadd --gid 1000 appgroup && \
    useradd --uid 1000 --gid appgroup --shell /bin/bash --create-home appuser

# Copy application code
COPY --chown=appuser:appgroup app/ ./app/

# Create documents directory (writable by appuser) - must be before USER switch
RUN mkdir -p /tmp/askWRI_docs && chown appuser:appgroup /tmp/askWRI_docs

# Switch to non-root user
USER appuser

# Expose port
EXPOSE ${PORT:-8000}

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8000}/health || exit 1

# Run the application with optional S3 sync at startup
# S3 sync runs only if DOCUMENTS_S3_BUCKET is set, with retry logic
CMD ["sh", "-c", "\
    if [ -n \"$DOCUMENTS_S3_BUCKET\" ]; then \
        echo \"Syncing documents from S3...\"; \
        RETRIES=3; \
        DELAY=5; \
        for i in $(seq 1 $RETRIES); do \
            aws s3 sync "s3://${DOCUMENTS_S3_BUCKET}/${DOCUMENTS_S3_PREFIX:-}" /tmp/askWRI_docs \
                --no-progress \
                --only-show-errors \
                && echo \"S3 sync complete\" \
                && break; \
            echo \"S3 sync attempt $i failed, retrying in ${DELAY}s...\"; \
            sleep $DELAY; \
            DELAY=$((DELAY * 2)); \
        done || echo \"WARNING: S3 sync failed after $RETRIES attempts, continuing anyway\"; \
    else \
        echo \"DOCUMENTS_S3_BUCKET not set, skipping S3 sync\"; \
    fi && \
    exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${WORKERS:-1}\
"]
