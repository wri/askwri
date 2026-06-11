#!/usr/bin/env bash
# Baseline measurement suite for the keyword-lane replacement workstream.
#
# Run detached from any Claude/terminal session (double-fork; survives the
# launching session's death):
#   bash evaluation/run-baseline-suite.sh --daemon
#
# Steps (all incremental/resumable):
#   1. Boot search-service (postgres mode) if not already healthy
#   2. eval:cite          (checkpointed per query — safe to re-run)
#   3. eval:answer-retrieval (checkpointed per query)
#   4. non-English smoke set (rerank=false, ~2 min total)
#   5. POST /reindex timing (steady-state, postgres mode)
#
# Progress: tail -f evaluation/results/baseline-suite.log
# A step that already completed writes its marker to baseline-suite.state and
# is skipped on re-run.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$REPO/evaluation/results/baseline-suite.state"
cd "$REPO"
mkdir -p evaluation/results
touch "$STATE"

if [ "${1:-}" = "--daemon" ]; then
  # Double-fork: the subshell exits immediately, orphaning the worker to
  # launchd so it survives the launching session (no setsid on macOS).
  ( nohup bash "$0" >> evaluation/results/baseline-suite.log 2>&1 < /dev/null & )
  echo "Detached. Progress: tail -f evaluation/results/baseline-suite.log"
  exit 0
fi

log() { echo "[$(date '+%H:%M:%S')] $*"; }
done_step() { grep -qx "$1" "$STATE" 2>/dev/null; }
mark_step() { echo "$1" >> "$STATE"; }

# --- 1. service up? ---
if curl -sf --max-time 5 http://127.0.0.1:8000/health | grep -q '"ready":true'; then
  log "search-service already healthy"
else
  log "booting search-service (postgres mode)..."
  cd search-service
  nohup ./venv/bin/python -m app.main > ../evaluation/results/search-service.log 2>&1 &
  cd "$REPO"
  for i in $(seq 1 120); do
    sleep 5
    if curl -sf --max-time 5 http://127.0.0.1:8000/health | grep -q '"ready":true'; then
      break
    fi
  done
  if ! curl -sf --max-time 5 http://127.0.0.1:8000/health | grep -q '"ready":true'; then
    log "FATAL: search-service failed to become ready in 10 min"; exit 1
  fi
  log "search-service ready"
fi

# --- 2. cite eval ---
if done_step cite; then
  log "cite eval: already done, skipping"
else
  log "running eval:cite (checkpointed)..."
  if npx tsx evaluation/run-cite-eval.ts; then
    mark_step cite; log "cite eval: DONE"
  else
    log "cite eval FAILED (checkpoint preserved; re-run this script to resume)"; exit 1
  fi
fi

# --- 3. answer retrieval eval ---
if done_step answer; then
  log "answer eval: already done, skipping"
else
  log "running eval:answer-retrieval (checkpointed)..."
  if npx tsx evaluation/run-answer-retrieval-eval.ts; then
    mark_step answer; log "answer eval: DONE"
  else
    log "answer eval FAILED (checkpoint preserved; re-run to resume)"; exit 1
  fi
fi

# --- 4. non-English smoke baseline ---
if done_step smoke; then
  log "smoke baseline: already done, skipping"
else
  log "running non-English smoke set (rerank=false)..."
  if npx tsx evaluation/run-non-english-smoke.ts --label baseline; then
    mark_step smoke; log "smoke baseline: DONE"
  else
    log "smoke baseline FAILED"; exit 1
  fi
fi

# --- 5. /reindex steady-state timing ---
if done_step reindex; then
  log "reindex timing: already done, skipping"
else
  log "timing POST /reindex (postgres mode, steady state)..."
  T0=$(date +%s)
  HTTP=$(curl -s -o evaluation/results/reindex-timing-response.json -w '%{http_code}' \
    --max-time 3600 -X POST http://127.0.0.1:8000/reindex)
  T1=$(date +%s)
  echo "{\"http_status\": $HTTP, \"seconds\": $((T1 - T0))}" > evaluation/results/reindex-timing.json
  log "reindex: HTTP $HTTP in $((T1 - T0))s"
  if [ "$HTTP" = "200" ]; then mark_step reindex; fi
fi

log "BASELINE SUITE COMPLETE"
