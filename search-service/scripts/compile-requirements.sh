#!/usr/bin/env bash
# Regenerate the pinned requirements from the .in source files.
#
# Runs pip-compile INSIDE the deploy image (python:3.12-slim) rather than on
# your local interpreter. That matters: resolution depends on the Python
# version and platform, and local dev runs 3.13 on macOS while the image and
# CI run 3.12 on linux. Compiling locally would pin a set that does not match
# what actually ships.
#
# Usage:  ./scripts/compile-requirements.sh          (from search-service/)
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="python:3.12-slim"

echo "==> compiling requirements.txt from requirements.in ($IMAGE)"
docker run --rm -v "$PWD:/w" -w /w "$IMAGE" sh -c '
  pip install --quiet --no-cache-dir pip-tools &&
  pip-compile --quiet --strip-extras --output-file=requirements.txt requirements.in
'

echo "==> compiling requirements-dev.txt from requirements-dev.in"
docker run --rm -v "$PWD:/w" -w /w "$IMAGE" sh -c '
  pip install --quiet --no-cache-dir pip-tools &&
  pip-compile --quiet --strip-extras --output-file=requirements-dev.txt requirements-dev.in
'

echo "==> done. Review the diff, then commit both .in and .txt files together."
