#!/usr/bin/env bash
#
# Clone one environment's finished corpus into another, as a literal data copy.
#
#   ./scripts/clone-corpus.sh qa production --dry-run
#   ./scripts/clone-corpus.sh qa production
#
# Used for the 2026-08-07 production cutover (qa -> production). The direction
# is an argument because it is expected to invert: once production is the
# primary ingestion path and accumulates documents qa lacks, keeping the lab
# representative means cloning production -> qa.
#
# Why clone rather than replay the ingestion pipeline: a data copy is a
# self-consistent literal mirror, it takes minutes instead of hours, it costs
# no OCR or embedding spend, and it carries document_texts' parse-cache stamps
# so the target inherits a warm cache and never re-OCRs. A replay would also
# require re-running build_sparse_keyword.py; a clone does not, because
# keyword_vocab, keyword_corpus_stats and document_chunks.sparse all travel
# together and stay internally consistent.
#
# Table-at-a-time in an explicit dependency order rather than one pg_dump of
# everything: --data-only dumps carry no FK ordering guarantee, and the usual
# escape hatch (--disable-triggers) needs superuser, which the `askwri` role is
# not. An explicit order is the thing we can actually guarantee.
#
# NEVER TOUCHES, in either direction: users, audit_log, ingestion_jobs, and the
# telemetry tables (answer_mode_feedback, answer_mode_query_logs,
# cite_mode_feedback, cite_mode_query_logs, user_feedback, migrations). Those
# are each environment's own history. Clone by explicit table list; never
# restore a whole-database dump over a deployed environment.
#
# Requires: aws CLI session, psql + pg_dump >= the server major version, and
# your IP allowed on the RDS security group.
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"

usage() {
  echo "Usage: $0 <source-env> <target-env> [--dry-run]" >&2
  echo "Example: $0 qa production --dry-run" >&2
  exit 2
}

[ $# -ge 2 ] || usage
SOURCE_ENV="$1"; TARGET_ENV="$2"; shift 2
DRY_RUN=""
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

for e in "$SOURCE_ENV" "$TARGET_ENV"; do
  case "$e" in qa|production) ;; *) echo "Unknown environment '$e'." >&2; usage ;; esac
done
[ "$SOURCE_ENV" != "$TARGET_ENV" ] || { echo "Source and target are the same." >&2; exit 2; }

# Parents first. document_tags and document_collections come last because they
# reference two parents each.
TABLES=(
  tags
  collections
  keyword_vocab
  keyword_corpus_stats
  documents
  document_texts
  document_chunks
  document_summaries
  document_relations
  document_tags
  document_collections
)

# Dropped before the load and rebuilt after -- maintaining HNSW during a bulk
# COPY is markedly slower than building it once at the end. Kept as a literal
# so the rebuilt index matches the migration's definition exactly.
HNSW_NAME="idx_chunks_embedding_hnsw_cohere_v4"
HNSW_DDL="CREATE INDEX ${HNSW_NAME} ON public.document_chunks USING hnsw (((embedding)::vector(1536)) vector_cosine_ops) WHERE (embedding_model = 'cohere-embed-v4'::text)"

# Build a connection URL from the environment's live ECS task definition, the
# same source of truth scripts/with-remote-env.sh uses. Nothing is hardcoded and
# there is no way to point a command at the wrong database by mistake: the
# DB_NAME in the task definition must equal the environment name.
url_for() {
  aws ecs describe-task-definition --task-definition "askwri-app-$1" --region "$REGION" \
    --query "taskDefinition.containerDefinitions[].environment[?starts_with(name,'DB_')].{n:name,v:value} | []" \
    --output json |
  ENVIRONMENT="$1" python3 -c '
import json, os, sys, urllib.parse
v = {e["n"]: e["v"] for e in json.load(sys.stdin)}
want = os.environ["ENVIRONMENT"]
got = v.get("DB_NAME")
if got != want:
    sys.exit("ABORT: " + want + " task def DB_NAME is " + repr(got))
print("postgresql://{u}:{p}@{h}:{port}/{db}?sslmode=require".format(
    u=urllib.parse.quote(v["DB_USER"], safe=""),
    p=urllib.parse.quote(v["DB_PASSWORD"], safe=""),
    h=v["DB_HOST"], port=v["DB_PORT"], db=v["DB_NAME"]))
'
}

echo "Resolving connection strings from ECS task definitions..." >&2
SRC_URL=$(url_for "$SOURCE_ENV")
DST_URL=$(url_for "$TARGET_ENV")

# The URLs are already built from DB_NAME, but assert on the rendered path too.
case "$SRC_URL" in *"/$SOURCE_ENV?sslmode=require") ;; *) echo "ABORT: source URL malformed" >&2; exit 1;; esac
case "$DST_URL" in *"/$TARGET_ENV?sslmode=require") ;; *) echo "ABORT: target URL malformed" >&2; exit 1;; esac

echo
echo "Source: $SOURCE_ENV   ->   Target: $TARGET_ENV"
echo "Tables, in FK dependency order:"
for t in "${TABLES[@]}"; do
  n=$(psql "$SRC_URL" -tAc "SELECT count(*) FROM $t")
  m=$(psql "$DST_URL" -tAc "SELECT count(*) FROM $t")
  printf '  %-22s %s=%-8s %s=%s\n' "$t" "$SOURCE_ENV" "$n" "$TARGET_ENV" "$m"
done

echo
echo "Untouched on $TARGET_ENV: users, audit_log, ingestion_jobs, migrations,"
echo "  answer_mode_feedback, answer_mode_query_logs, cite_mode_feedback,"
echo "  cite_mode_query_logs, user_feedback"

if [ -n "$DRY_RUN" ]; then
  echo
  echo "Dry run - nothing written."
  exit 0
fi

echo
echo "This TRUNCATEs those 10 tables on $TARGET_ENV and replaces them with $SOURCE_ENV's data."
read -r -p "Type the target environment name to proceed: " reply
[ "$reply" = "$TARGET_ENV" ] || { echo "Aborted."; exit 1; }

echo
echo "==> Dropping the HNSW index on $TARGET_ENV (rebuilt after the load)"
psql "$DST_URL" -q -c "DROP INDEX IF EXISTS ${HNSW_NAME}"

echo "==> Truncating targets"
psql "$DST_URL" -q -c "TRUNCATE $(IFS=,; echo "${TABLES[*]}") CASCADE"

for t in "${TABLES[@]}"; do
  printf '==> %-22s ' "$t"
  start=$(date +%s)
  pg_dump "$SRC_URL" --data-only --no-owner --no-privileges --table="public.$t" \
    | psql "$DST_URL" -q -v ON_ERROR_STOP=1
  n=$(psql "$DST_URL" -tAc "SELECT count(*) FROM $t")
  echo "$n rows in $(( $(date +%s) - start ))s"
done

# keyword_vocab.token_id is GENERATED ALWAYS AS IDENTITY. COPY carries the
# values across, but the sequence behind them does not follow, so without this
# the next ingest that mints a token collides on the unique constraint.
echo
echo "==> Resetting identity sequences"
psql "$DST_URL" -q -c "SELECT setval(pg_get_serial_sequence('keyword_vocab','token_id'), COALESCE((SELECT max(token_id) FROM keyword_vocab), 1), true)"

echo "==> Rebuilding the HNSW index (a few minutes)"
start=$(date +%s)
psql "$DST_URL" -q -c "$HNSW_DDL"
echo "    done in $(( $(date +%s) - start ))s"

echo "==> ANALYZE"
psql "$DST_URL" -q -c "ANALYZE $(IFS=,; echo "${TABLES[*]}")"

echo
echo "Clone complete. Verify with:"
echo "  ./scripts/verify-corpus-parity.sh $SOURCE_ENV $TARGET_ENV"
echo
echo "Then force a new deployment of the target's search-service and ingestion"
echo "worker -- neither restarts on its own, and until they do the search"
echo "service serves whatever corpus it loaded at boot."
