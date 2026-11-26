#!/usr/bin/env bash
#
# sync-corpus.sh — copy documents and their full processing chain from one
# environment into another. INSERT-ONLY. It never updates and never deletes.
#
#   ./scripts/sync-corpus.sh qa production --ids-file /tmp/qa-only-ids.txt
#   ./scripts/sync-corpus.sh production qa          # dry run, all missing docs
#   ./scripts/sync-corpus.sh production qa --apply
#
# WHY THIS EXISTS
#   Both ingestion workers read the shared askwri-data bucket but list different
#   intake prefixes (INTAKE_S3_PREFIX: production watches intake/, qa watches
#   qa-intake/). A document dropped in one prefix reaches only that environment,
#   so the two databases diverge in BOTH directions. On 2026-11-26 production
#   held 326 documents qa lacked and qa held 69 production lacked. Neither side
#   was a superset, so every one-way copy tool in this directory (clone-corpus.sh
#   TRUNCATEs; mirror-qa-to-production.sh overwrites wholesale) would have
#   destroyed the other side's work.
#
#   This is the tool for moving documents between environments when both hold
#   real work. It adds what is missing and leaves everything else alone.
#
# WHAT IT COPIES, AND WHY EACH TABLE IS NEEDED
#   document_texts carries full_text/page_boundaries — citations point into it —
#   and the parse-cache stamps, so the target never re-OCRs a document the
#   source already parsed.
#   document_chunks carries the embeddings and sparse vectors. A document without
#   them exists in the corpus and is invisible to every retrieval lane.
#   document_summaries, document_tags, document_relations and
#   document_collections are what the document is FOR.
#   Copying a document row alone would be worse than not copying it: it would
#   inflate corpus counts while contributing nothing searchable.
#
# WHAT IT DELIBERATELY DOES NOT DO
#   No field-level merge. If the document exists on both sides, this script does
#   nothing to it — reconciling two humans' edits of the same field is a
#   different problem with a different answer, and guessing at it silently is how
#   provenance gets lost. It reports such documents instead.
#   No keyword_vocab / keyword_corpus_stats rebuild. Both are corpus-derived; the
#   script prints the rebuild command to run afterwards.
#
# SAFETY
#   Dry run is the default; --apply commits. A dry run executes the real inserts
#   inside a transaction and ROLLBACKs, so the counts it prints are exact.
#   All inserts run in ONE transaction: a document half-copied (chunks without
#   texts, say) is not a state worth being able to reach.
#   Every insert is ON CONFLICT DO NOTHING, so the script is idempotent.
#   Documents that would violate a unique index on the target (same
#   external_id, same content_hash — i.e. the target already holds that
#   document under a different id) are SKIPPED and listed. Copying them would
#   either fail or create a duplicate; neither is wanted.
#
# Requires: aws CLI session, psql on PATH, your IP allowed on the RDS security
# group (docs/runbooks/connect-to-qa-database.md).
set -euo pipefail

export NO_COLOR=1 FORCE_COLOR=0

APPLY=0
IDS_FILE=""
WORK="${TMPDIR:-/tmp}/sync-corpus-$(date -u +%Y%m%d-%H%M%S)"

usage() {
  echo "Usage: $0 <source-env> <target-env> [--ids-file <path>] [--apply]" >&2
  echo "Example: $0 qa production --ids-file /tmp/qa-only-ids.txt" >&2
  exit 2
}

[ $# -ge 2 ] || usage
SOURCE_ENV="$1"; TARGET_ENV="$2"; shift 2
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ids-file) IDS_FILE="$2"; shift 2 ;;
    --apply)    APPLY=1; shift ;;
    -h|--help)  sed -n '2,60p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

for e in "$SOURCE_ENV" "$TARGET_ENV"; do
  case "$e" in qa|production) ;; *) echo "Unknown environment '$e'." >&2; usage ;; esac
done
[ "$SOURCE_ENV" != "$TARGET_ENV" ] || { echo "Source and target are the same." >&2; exit 2; }

END="rollback;"; MODE="DRY RUN (rolling back)"
[ "$APPLY" -eq 1 ] && { END="commit;"; MODE="APPLY (committing)"; }

mkdir -p "$WORK"
echo "=== sync-corpus | $SOURCE_ENV -> $TARGET_ENV | $MODE ==="
echo "work dir: $WORK"
echo

psql_src() { ./scripts/with-remote-env.sh "$SOURCE_ENV" psql -X -t -A -v ON_ERROR_STOP=1 "$@"; }
psql_tgt() { ./scripts/with-remote-env.sh "$TARGET_ENV" psql -X -t -A -v ON_ERROR_STOP=1 "$@"; }

# ---------------------------------------------------------------- preconditions
echo "--- preconditions ---"
if ! command -v psql >/dev/null 2>&1; then
  echo "  FAIL psql not found on PATH — brew install libpq, then add its bin to PATH"
  exit 2
fi
_top=$(git rev-parse --show-toplevel 2>/dev/null) || _top=""
if [ -z "$_top" ]; then
  if [ "$APPLY" -eq 1 ]; then
    echo "  FAIL not in a git checkout — cannot verify tooling"
    exit 1
  fi
  echo "  WARN not in a git checkout (read-only continues)"
else
  . "$(dirname "$0")/lib/release-preflight.sh"
  require_current_release_tool "$APPLY" scripts/sync-corpus.sh scripts/with-remote-env.sh
fi

# The source must not be mutating under the export. For qa that is now the
# permanent state (ingestion_worker_desired_count = 0 in qa.tfvars); for a
# production-source run it is the operator's job to stop it first.
src_running=$(aws ecs describe-services --cluster "askwri-app-$SOURCE_ENV-cluster" \
  --services "askwri-app-$SOURCE_ENV-ingestion-worker" --region us-east-2 \
  --query 'services[0].runningCount' --output text 2>/dev/null || echo "?")
case "$src_running" in
  0) echo "  OK   $SOURCE_ENV ingestion worker stopped" ;;
  ?) echo "  WARN could not read $SOURCE_ENV worker state — continuing, but verify it is quiet" ;;
  *) echo "  FAIL $SOURCE_ENV ingestion worker runningCount=$src_running — stop it first:"
     echo "       aws ecs update-service --cluster askwri-app-$SOURCE_ENV-cluster \\"
     echo "         --service askwri-app-$SOURCE_ENV-ingestion-worker --desired-count 0 --region us-east-2"
     exit 1 ;;
esac
echo

# ---------------------------------------------------------------- choose documents
echo "--- selecting documents ---"
psql_src -c "select id from documents order by id" | grep -v '^→' | LC_ALL=C sort -u > "$WORK/src-ids.txt"
psql_tgt -c "select id from documents order by id" | grep -v '^→' | LC_ALL=C sort -u > "$WORK/tgt-ids.txt"
LC_ALL=C comm -23 "$WORK/src-ids.txt" "$WORK/tgt-ids.txt" > "$WORK/missing.txt"
printf '  %-18s %s\n' "documents on $SOURCE_ENV" "$(wc -l < "$WORK/src-ids.txt" | tr -d ' ')"
printf '  %-18s %s\n' "documents on $TARGET_ENV" "$(wc -l < "$WORK/tgt-ids.txt" | tr -d ' ')"
printf '  %-18s %s\n' "missing on target"      "$(wc -l < "$WORK/missing.txt" | tr -d ' ')"

if [ -n "$IDS_FILE" ]; then
  [ -f "$IDS_FILE" ] || { echo "  FAIL --ids-file $IDS_FILE does not exist"; exit 2; }
  grep -v '^[[:space:]]*$' "$IDS_FILE" | sed 's/[[:space:]]//g' | LC_ALL=C sort -u > "$WORK/requested.txt"
  LC_ALL=C comm -12 "$WORK/requested.txt" "$WORK/missing.txt" > "$WORK/copy.txt"
  echo "  --ids-file restricts the run: $(wc -l < "$WORK/requested.txt" | tr -d ' ') requested, $(wc -l < "$WORK/copy.txt" | tr -d ' ') of them missing on target"
else
  cp "$WORK/missing.txt" "$WORK/copy.txt"
fi

# Ids as an inline SQL list. These are uuids read from the database, never user input.
ids_sql() { sed "s/.*/'&'/" "$1" | paste -sd, - ; }

if [ ! -s "$WORK/copy.txt" ]; then
  echo
  echo "Nothing to copy — $TARGET_ENV already has every requested document."
  exit 0
fi
echo

# ---------------------------------------------------------------- unique-index gate
# The target may already hold the same document under a different id. Inserting it
# would violate UQ_documents_external_id or UQ_documents_content_hash, so those are
# skipped and reported rather than allowed to fail mid-transaction.
echo "--- documents the target already holds under another id ---"
ids_sql "$WORK/copy.txt" > "$WORK/copy.list"
psql_src -c "
  select d.id||'|'||coalesce(d.external_id,'')||'|'||coalesce(d.content_hash,'')
    from documents d where d.id in ($(cat "$WORK/copy.list"))" | grep -v '^→' > "$WORK/cand.txt"

psql_tgt -c "select id||'|'||coalesce(external_id,'')||'|'||coalesce(content_hash,'') from documents" \
  | grep -v '^→' > "$WORK/tgt-keys.txt"

python3 "$(dirname "$0")/lib/compute-sync-keys.py" \
  "$WORK/cand.txt" "$WORK/tgt-keys.txt" "$WORK/final.txt" "$WORK/skip.txt"
if [ ! -s "$WORK/final.txt" ]; then
  echo
  echo "Every candidate is already present on $TARGET_ENV under another id. Nothing to do."
  exit 0
fi
echo

# ---------------------------------------------------------------- export
echo "--- exporting from $SOURCE_ENV ---"
ids_sql "$WORK/final.txt" > "$WORK/final.list"

exp() { # exp <name> <select>
  psql_src -c "\copy ($2) to '$WORK/$1.csv' with (format csv)" >/dev/null
  # Count from the database, not the file: full_text and chunk text carry embedded
  # newlines, so `wc -l` on a CSV would overcount.
  printf '  %-20s %s rows\n' "$1" "$(psql_src -c "select count(*) from ($2) z" | grep -v '^→' | tail -1)"
}

exp documents "
  select id, external_id, doi, s3_key, title, title_en, language, languages,
         year_published, publication_title, article_type, wri_primary_office,
         content_hash, extraction_confidence, status, source_metadata, created_at,
         updated_at, authors, url, date_published, metadata_source
    from documents where id in ($(cat "$WORK/final.list")) order by id"
exp texts "
  select document_id, full_text, page_boundaries, char_count, parsed_content_hash,
         parse_backend, parse_model
    from document_texts where document_id in ($(cat "$WORK/final.list")) order by document_id"
exp chunks "
  select id, document_id, legacy_chunk_id, chunk_index, unit_type, unit_number,
         section_path, page, caption, text, structured, language, node_metadata,
         embedding::text, embedding_model, dimension, sparse::text, created_at, corpus_order
    from document_chunks where document_id in ($(cat "$WORK/final.list"))
   order by document_id, chunk_index"
exp summaries "
  select document_id, language, kind, text, source, model_version
    from document_summaries where document_id in ($(cat "$WORK/final.list"))
   order by document_id, language, kind"
exp document_tags "
  select document_id, tag_id, source, confidence, model_version, status, created_at
    from document_tags where document_id in ($(cat "$WORK/final.list"))
   order by document_id, tag_id"
exp document_collections "
  select document_id, collection_id, added_by, added_at
    from document_collections where document_id in ($(cat "$WORK/final.list"))"
# Both endpoints must be landing on the target, or the FK will reject the row.
exp relations "
  select id, document_id, related_document_id, relation_type, status, source,
         confidence, signals, created_at, reviewed_by, reviewed_at
    from document_relations
   where document_id in ($(cat "$WORK/final.list"))
     and related_document_id in ($(cat "$WORK/final.list"))"
echo

# ---------------------------------------------------------------- apply
echo "--- applying to $TARGET_ENV ---"
{
  echo "begin;"
  echo "create temp table s_documents (id uuid, external_id text, doi text, s3_key text,
    title text, title_en text, language text, languages text[], year_published integer,
    publication_title text, article_type text, wri_primary_office text, content_hash text,
    extraction_confidence numeric, status text, source_metadata jsonb, created_at timestamptz,
    updated_at timestamptz, authors text, url text, date_published date, metadata_source jsonb);"
  echo "\\copy s_documents from '$WORK/documents.csv' with (format csv)"
  echo "insert into documents select * from s_documents on conflict do nothing;"

  echo "create temp table s_texts (document_id uuid, full_text text, page_boundaries jsonb,
    char_count integer, parsed_content_hash text, parse_backend text, parse_model text);"
  echo "\\copy s_texts from '$WORK/texts.csv' with (format csv)"
  echo "insert into document_texts select * from s_texts on conflict do nothing;"

  echo "create temp table s_chunks (id uuid, document_id uuid, legacy_chunk_id text,
    chunk_index integer, unit_type text, unit_number text, section_path text, page integer,
    caption text, text text, structured jsonb, language text, node_metadata jsonb,
    embedding_t text, embedding_model text, dimension integer, sparse_t text,
    created_at timestamptz, corpus_order integer);"
  echo "\\copy s_chunks from '$WORK/chunks.csv' with (format csv)"
  echo "insert into document_chunks (id, document_id, legacy_chunk_id, chunk_index, unit_type,
    unit_number, section_path, page, caption, text, structured, language, node_metadata,
    embedding, embedding_model, dimension, sparse, created_at, corpus_order)
    select id, document_id, legacy_chunk_id, chunk_index, unit_type, unit_number,
    section_path, page, caption, text, structured, language, node_metadata,
    embedding_t::vector, embedding_model, dimension, sparse_t::sparsevec, created_at, corpus_order
    from s_chunks on conflict do nothing;"

  echo "create temp table s_summaries (document_id uuid, language text, kind text, text text,
    source text, model_version text);"
  echo "\\copy s_summaries from '$WORK/summaries.csv' with (format csv)"
  echo "insert into document_summaries select * from s_summaries on conflict do nothing;"

  echo "create temp table s_tags (document_id uuid, tag_id uuid, source text,
    confidence numeric, model_version text, status text, created_at timestamptz);"
  echo "\\copy s_tags from '$WORK/document_tags.csv' with (format csv)"
  echo "insert into document_tags select * from s_tags on conflict do nothing;"

  echo "create temp table s_colls (document_id uuid, collection_id uuid, added_by text,
    added_at timestamptz);"
  echo "\\copy s_colls from '$WORK/document_collections.csv' with (format csv)"
  echo "insert into document_collections select * from s_colls on conflict do nothing;"

  echo "create temp table s_rels (id uuid, document_id uuid, related_document_id uuid,
    relation_type text, status text, source text, confidence numeric, signals jsonb,
    created_at timestamptz, reviewed_by text, reviewed_at timestamptz);"
  echo "\\copy s_rels from '$WORK/relations.csv' with (format csv)"
  echo "insert into document_relations select * from s_rels on conflict do nothing;"

  # Exact, not estimated: these run inside the same transaction as the inserts.
  echo "select 'documents_copied', count(*)::text from documents where id in ($(cat "$WORK/final.list"));"
  echo "select 'chunks_copied', count(*)::text from document_chunks where document_id in ($(cat "$WORK/final.list"));"
  echo "select 'unembedded_chunks', count(*)::text from document_chunks
        where document_id in ($(cat "$WORK/final.list")) and embedding is null;"
  echo "select 'documents_without_chunks', count(*)::text from documents d
        where d.id in ($(cat "$WORK/final.list"))
          and not exists (select 1 from document_chunks c where c.document_id=d.id);"
  echo "select 'documents_without_texts', count(*)::text from documents d
        where d.id in ($(cat "$WORK/final.list"))
          and not exists (select 1 from document_texts t where t.document_id=d.id);"
  echo "$END"
} > "$WORK/apply.sql"

psql_tgt -f "$WORK/apply.sql" | grep -v '^→'
echo

# The two counts below are the point of the last two selects: a copy that inserts a
# document without its chunks is a silent retrieval hole, so both must be 0.
echo "=== $MODE complete ==="
if [ "$APPLY" -eq 0 ]; then
  cat <<'NOTE'

This was a DRY RUN. Every statement ran and was rolled back; the counts above are exact.
Re-run with --apply to commit.
NOTE
else
  cat <<NOTE

Committed. Next, in this order:
  1. Rebuild the corpus-derived sparse vocabulary, or the newly copied chunks are
     under-weighted on the sparse lane:
       ./scripts/with-remote-env.sh $TARGET_ENV bash -c 'cd search-service && ./venv/bin/python -m scripts.build_sparse_keyword'
       (or the equivalent full backfill named in docs/runbooks/qa-push-deploy.md)
  2. Restart $TARGET_ENV's search-service — it serves whatever passage context it
     loaded at boot, so until it restarts the new documents cannot be retrieved.
NOTE
fi
