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
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# Dependencies stage
# =============================================================================

FROM base as dependencies

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Export + int8-quantize the reranker at build time (answer and cite modes
# share bge-reranker-v2-m3). The fp32 ONNX export is >2GB (external-data
# format) and cannot be loaded when exported on the fly; the quantized model
# is a single ~570MB file and is the CPU-serving path on Fargate. The fp32
# intermediates are deleted to keep the image small.
ENV HF_HOME=/opt/models
ENV RERANKER_ONNX_DIR=/opt/models/bge-reranker-v2-m3-onnx
RUN optimum-cli export onnx --model BAAI/bge-reranker-v2-m3 --task text-classification ${RERANKER_ONNX_DIR} && \
    python -c "from optimum.onnxruntime import ORTQuantizer; \
from optimum.onnxruntime.configuration import AutoQuantizationConfig; \
import os; d = os.environ['RERANKER_ONNX_DIR']; \
q = ORTQuantizer.from_pretrained(d, file_name='model.onnx'); \
q.quantize(save_dir=d, quantization_config=AutoQuantizationConfig.avx512_vnni(is_static=False, per_channel=False))" && \
    rm ${RERANKER_ONNX_DIR}/model.onnx ${RERANKER_ONNX_DIR}/model.onnx_data

# =============================================================================
# Production stage
# =============================================================================

FROM dependencies as production

# Copy pre-downloaded models from dependencies stage
COPY --from=dependencies /opt/models /opt/models
ENV HF_HOME=/opt/models

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

# Make models readable by appuser
RUN chmod -R a+r /opt/models

# Switch to non-root user
USER appuser

# Expose port
EXPOSE ${PORT:-8000}

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8000}/health || exit 1

# Run the application with optional S3 sync at startup
CMD ["/app/start.sh"]
