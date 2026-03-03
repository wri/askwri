#!/bin/sh
set -e

if [ -n "$DOCUMENTS_S3_BUCKET" ]; then
    echo "Listing S3 contents before sync:"
    aws s3 ls "s3://${DOCUMENTS_S3_BUCKET}/${DOCUMENTS_S3_PREFIX:-}"
    echo "Syncing documents from S3..."
    RETRIES=3
    DELAY=5
    SUCCESS=0
    for i in $(seq 1 $RETRIES); do
        if aws s3 sync "s3://${DOCUMENTS_S3_BUCKET}/${DOCUMENTS_S3_PREFIX:-}" /tmp/askWRI_docs \
            --no-progress \
            --only-show-errors; then
            echo "S3 sync complete."
            echo "Contents of /tmp/askWRI_docs after sync:"
            ls -lh /tmp/askWRI_docs
            SUCCESS=1
            break
        fi
        echo "S3 sync attempt $i failed, retrying in ${DELAY}s..."
        sleep $DELAY
        DELAY=$((DELAY * 2))
    done
    if [ $SUCCESS -eq 0 ]; then
        echo "WARNING: S3 sync failed after $RETRIES attempts, continuing anyway"
    fi
else
    echo "DOCUMENTS_S3_BUCKET not set, skipping S3 sync"
fi

exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${WORKERS:-1}
