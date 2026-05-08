#!/bin/sh
set -e

sync_from_s3() {
    label="$1"
    source="$2"
    dest="$3"
    retries=3
    delay=5

    echo "Syncing ${label} from S3..."
    for i in $(seq 1 $retries); do
        if aws s3 sync "$source" "$dest" \
            --no-progress \
            --only-show-errors; then
            echo "S3 ${label} sync complete"
            return 0
        fi
        echo "S3 ${label} sync attempt $i failed, retrying in ${delay}s..."
        sleep $delay
        delay=$((delay * 2))
    done
    echo "WARNING: S3 ${label} sync failed after $retries attempts, continuing anyway"
}

if [ -n "$DOCUMENTS_S3_BUCKET" ]; then
    mkdir -p /tmp/askWRI_docs /tmp/askWRI_cache
    sync_from_s3 "documents" "s3://${DOCUMENTS_S3_BUCKET}/${DOCUMENTS_S3_PREFIX:-}" /tmp/askWRI_docs
    sync_from_s3 "cache" "s3://${DOCUMENTS_S3_BUCKET}/${CACHE_S3_PREFIX:-}" /tmp/askWRI_cache
else
    echo "DOCUMENTS_S3_BUCKET not set, skipping S3 sync"
fi

exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${WORKERS:-1}
