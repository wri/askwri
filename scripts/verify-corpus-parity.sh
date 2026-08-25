#!/usr/bin/env bash
#
# Prove two environments hold the same corpus. Read-only on both.
#
#   ./scripts/verify-corpus-parity.sh qa production
#
# Every number is derived from the two live databases at run time. Nothing is
# compared against a figure written down in a runbook, on purpose: the
# "168 documents / 27,878 chunks" quoted in prod-cutover-multilingual-v3.md was
# correct on 2026-07-23 and wrong within a fortnight. Counts belong in the
# database, not in prose.
#
# Exit status is 0 only if every probe matches, so this is usable as a gate.
set -euo pipefail
REGION="${AWS_REGION:-us-east-2}"

usage() { echo "Usage: $0 <env-a> <env-b>   (e.g. $0 qa production)" >&2; exit 2; }
[ $# -eq 2 ] || usage
A="$1"; B="$2"
for e in "$A" "$B"; do
  case "$e" in qa|production) ;; *) echo "Unknown environment '$e'." >&2; usage ;; esac
done

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

A_URL=$(url_for "$A")
B_URL=$(url_for "$B")

# One scalar per probe so the two sides diff mechanically rather than by eye.
probes=(
  "active_docs|SELECT count(*) FROM documents WHERE status <> 'withdrawn'"
  "searchable_docs|SELECT count(*) FROM documents WHERE status = 'searchable'"
  "total_docs|SELECT count(*) FROM documents"
  "chunks|SELECT count(*) FROM document_chunks"
  "null_embeddings|SELECT count(*) FROM document_chunks WHERE embedding IS NULL"
  "null_sparse|SELECT count(*) FROM document_chunks WHERE sparse IS NULL"
  "non_cohere_chunks|SELECT count(*) FROM document_chunks WHERE embedding_model <> 'cohere-embed-v4'"
  "texts|SELECT count(*) FROM document_texts"
  "uncached_active|SELECT count(*) FROM document_texts t JOIN documents d ON d.id=t.document_id WHERE d.status <> 'withdrawn' AND t.parsed_content_hash IS NULL"
  "summaries|SELECT count(*) FROM document_summaries"
  "tags|SELECT count(*) FROM tags"
  "document_tags|SELECT count(*) FROM document_tags"
  "human_tags|SELECT count(*) FROM document_tags WHERE source = 'human'"
  "document_relations|SELECT count(*) FROM document_relations"
  "confirmed_pairs|SELECT count(*) FROM document_relations WHERE status = 'confirmed'"
  "collections|SELECT count(*) FROM collections"
  "document_collections|SELECT count(*) FROM document_collections"
  "vocab_terms|SELECT count(*) FROM keyword_vocab"
  "vocab_n_chunks|SELECT n_chunks FROM keyword_corpus_stats"
  "vocab_avgdl|SELECT round(avgdl::numeric,2) FROM keyword_corpus_stats"
  "distinct_languages|SELECT count(DISTINCT language) FROM documents WHERE language IS NOT NULL"
  "non_en_docs|SELECT count(*) FROM documents WHERE language IS NOT NULL AND language <> 'en'"
)

fail=0
printf '%-22s %-12s %-12s %s\n' PROBE "$A" "$B" ''
for p in "${probes[@]}"; do
  name=${p%%|*}; sql=${p#*|}
  a=$(psql "$A_URL" -tAc "$sql")
  b=$(psql "$B_URL" -tAc "$sql")
  if [ "$a" = "$b" ]; then mark="ok"; else mark="MISMATCH"; fail=1; fi
  printf '%-22s %-12s %-12s %s\n' "$name" "$a" "$b" "$mark"
done

echo
echo "Parse stamps on $B (this is the inherited OCR cache -- a NULL model here"
echo "means that document re-OCRs, and costs money, on its next re-ingest):"
psql "$B_URL" -c "SELECT parse_backend, parse_model, count(*) FROM document_texts GROUP BY 1,2 ORDER BY 3 DESC"

echo "HNSW index on $B:"
psql "$B_URL" -c "SELECT indexname FROM pg_indexes WHERE tablename='document_chunks' AND indexname LIKE '%hnsw%'"

echo "Tables on $B that a clone must never have touched:"
psql "$B_URL" -c "SELECT 'users' AS t, count(*) FROM users
  UNION ALL SELECT 'audit_log', count(*) FROM audit_log
  UNION ALL SELECT 'ingestion_jobs', count(*) FROM ingestion_jobs
  UNION ALL SELECT 'cite_mode_query_logs', count(*) FROM cite_mode_query_logs
  UNION ALL SELECT 'answer_mode_query_logs', count(*) FROM answer_mode_query_logs
  UNION ALL SELECT 'user_feedback', count(*) FROM user_feedback"

echo
if [ "$fail" = 0 ]; then
  echo "RESULT: $B mirrors $A on every probe."
else
  cat <<'NOTE'
RESULT: at least one probe MISMATCHED.

Before treating that as a failure, check whether it is vocab_terms alone. Every
ingest mints previously-unseen tokens into keyword_vocab at df=1 against the
frozen stats, so any document ingested on one side after the clone puts that
side ahead. It is expected drift, not corruption, and it clears on the next
scripts/build_sparse_keyword.py run. A mismatch in any other probe is real.
NOTE
  exit 1
fi
