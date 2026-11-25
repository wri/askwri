#!/bin/sh
set -e

# No S3 sync at boot (#502). Downloading the corpus (607 objects / 3.12 GB =
# 2m00s) took longer than the ALB's 75s unhealthy window, so tasks were killed
# before `node` ever bound :3000. Documents are read from S3 by s3_key
# (src/app/api/pdf, admin preview) and the catalog from Postgres;
# /tmp/askWRI_docs is only a local-dev fallback.
exec node server.js
