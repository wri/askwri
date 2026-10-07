#!/usr/bin/env bash
#
# mirror-qa-to-production.sh — copy qa's finished data to production without re-ingesting.
#
# WHAT THIS IS FOR
#   Production and qa run the same corpus. qa accumulates the expensive, human-and-model
#   work: reviewed summaries, curated tags, promotions, taxonomy, tag embeddings. This
#   script moves that work to production by COPYING it. It runs no model, spends nothing
#   on Bedrock or OCR, and never re-ingests a document.
#
#   It is the tool the 2026-09-19 release was executed with, generalised. Read
#   docs/runbooks/production-release.md before running it.
#
# SAFETY MODEL
#   * Dry run is the default. --apply is required to commit.
#   * A dry run executes the REAL statements inside a transaction and ROLLBACKs, so the
#     row counts and guard results it prints are exact, not estimates.
#   * Every destructive step is guarded by an assertion that RAISES inside the
#     transaction. A tripped guard aborts and writes nothing.
#   * Each table is its own transaction, so a failure is contained and re-runnable.
#
# THE GUARDS, AND WHY EACH EXISTS
#   geography cascade  DELETE FROM tags WHERE facet='geography' cascades to document_tags.
#                      If any document_tags row references a geography tag, the delete
#                      would silently destroy real assignments, including protected
#                      external/human rows. Must be 0.
#   human rows         No document_tags row with source='human' may be deleted, ever.
#                      (CLAUDE.md write-ownership.) On 2026-09-19 this guard is what
#                      proved the 65-row deletion was safe.
#   external rows      Deleting a source='external' row is a recorded exception, not a
#                      routine. The script requires you to state how many you expect via
#                      --allow-external-deletes N (default 0) and aborts on any other count.
#   prod-only tags     Every surviving production tag must exist in qa, or the upsert
#                      would orphan it.
#
# PRECONDITIONS (checked, not assumed)
#   1. BOTH ingestion workers at desired_count 0. qa's too — it is the copy SOURCE, and
#      qa and production share s3://askwri-data/intake/, so a live qa worker can mutate
#      the source mid-copy.
#   2. Migrations already applied to production (this script does not run them).
#   3. An RDS snapshot taken. `aws rds create-db-snapshot --db-instance-identifier askwri-db1
#      --db-snapshot-identifier pre-release-<date>`. One server-side call, no egress —
#      strictly better than pg_dump, which streams ~1 GB off a t4g.small that also serves
#      live production traffic and all of qa.
#
# USAGE
#   ./scripts/mirror-qa-to-production.sh                      # dry run, all tables
#   ./scripts/mirror-qa-to-production.sh --only documents     # dry run, one table
#   ./scripts/mirror-qa-to-production.sh --apply              # commit
#   ./scripts/mirror-qa-to-production.sh --apply --allow-external-deletes 1
#
# AFTER RUNNING
#   ./scripts/fingerprint-corpus.sh production qa   # must report all gated objects MATCH
#   Then build_search_vocab, then deploy. Order matters — see the runbook.
#
set -euo pipefail

APPLY=0
ONLY=""
ALLOW_EXT=0
WORK="${TMPDIR:-/tmp}/mirror-qa-prod-$(date -u +%Y%m%d-%H%M%S)"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --only) ONLY="$2"; shift 2 ;;
    --allow-external-deletes) ALLOW_EXT="$2"; shift 2 ;;
    -h|--help) sed -n '2,60p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

END="rollback;"; MODE="DRY RUN (rolling back)"
[ "$APPLY" -eq 1 ] && { END="commit;"; MODE="APPLY (committing)"; }

mkdir -p "$WORK"
echo "=== mirror qa -> production | $MODE ==="
echo "work dir: $WORK"
echo

want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
psql_prod() { ./scripts/with-remote-env.sh production psql -X -t -A -F'|' -v ON_ERROR_STOP=1 "$@"; }
psql_qa()   { ./scripts/with-remote-env.sh qa         psql -X -t -A -F'|' -v ON_ERROR_STOP=1 "$@"; }

# ---------------------------------------------------------------- preconditions
echo "--- preconditions ---"
for spec in "production:askwri-app-production-cluster:askwri-app-production-ingestion-worker" \
            "qa:askwri-app-qa-cluster:askwri-app-qa-ingestion-worker"; do
  envn="${spec%%:*}"; rest="${spec#*:}"; cluster="${rest%%:*}"; svc="${rest#*:}"
  running=$(aws ecs describe-services --cluster "$cluster" --services "$svc" \
            --region us-east-2 --query 'services[0].runningCount' --output text 2>/dev/null || echo "?")
  if [ "$running" = "0" ]; then
    echo "  OK   $envn worker stopped"
  else
    echo "  FAIL $envn worker runningCount=$running — scale it to 0 first:"
    echo "       aws ecs update-service --cluster $cluster --service $svc --desired-count 0 --region us-east-2"
    exit 1
  fi
done

# Fail CLOSED. If this check cannot run, that is a failure — not a pass. Discarding
# stderr here would let an auth/network error read as "0 pending" and march on against
# an unmigrated production, which is the false-green class §0 of the runbook exists to
# warn about.
if ! mig_out=$(./scripts/with-remote-env.sh production npm run typeorm -- migration:show \
                 -d src/db/migration-data-source.ts 2>&1); then
  echo "  FAIL could not read migration state from production:"
  printf '%s\n' "$mig_out" | tail -5 | sed 's/^/       /'
  exit 1
fi
if ! printf '%s' "$mig_out" | grep -q '^\[X\]'; then
  echo "  FAIL migration:show returned no recognizable migration list — refusing to assume 0 pending:"
  printf '%s\n' "$mig_out" | tail -5 | sed 's/^/       /'
  exit 1
fi
pending=$(printf '%s' "$mig_out" | grep -c '^\[ \]' || true)
if [ "${pending:-0}" -gt 0 ]; then
  echo "  FAIL production has $pending pending migration(s). Run them first."
  exit 1
fi
echo "  OK   no pending migrations on production"
echo

# ---------------------------------------------------------------- export from qa
echo "--- exporting from qa (source of truth) ---"
exp() { # exp <name> <select-list-and-from>
  psql_qa -c "\copy ($2) to '$WORK/$1.csv' with (format csv)" >/dev/null
  printf '  %-18s %s rows\n' "$1" "$(psql_qa -c "select count(*) from ($2) z" | tail -1)"
}
want documents && exp documents \
  "select id, doi, title, title_en, year_published, publication_title, article_type,
          wri_primary_office, status, authors, url, date_published, metadata_source, updated_at
     from documents order by id"
want summaries && exp summaries \
  "select document_id, language, kind, text, source, model_version
     from document_summaries order by document_id, language, kind"
want chunks && exp chunks \
  "select document_id, chunk_index, text, embedding::text, sparse::text, corpus_order
     from document_chunks order by document_id, chunk_index"
want relations && exp relations \
  "select id, document_id, related_document_id, relation_type, status, source, confidence,
          signals, created_at, reviewed_by, reviewed_at from document_relations order by id"
want tags && exp tags \
  "select id, facet, value_id, taxonomy_version, parent_tag_id, description, needs_reembed
     from tags order by facet, value_id"
want tags && exp tag_aliases "select tag_id, alias, created_at from tag_aliases order by 1,2"
want tags && exp tag_embeddings \
  "select tag_id, embedding_model, dimension, embedding::text, embedded_text, embedded_at
     from tag_embeddings order by 1,2"
want doc_tags && exp document_tags \
  "select document_id, tag_id, source, confidence, model_version, status, created_at
     from document_tags order by 1,2"
echo

run_step() { # run_step <label> <sql>
  echo "--- $1 ---"
  printf '%s\n' "$2" > "$WORK/$1.sql"
  psql_prod -f "$WORK/$1.sql" | grep -v '^→' || { echo "  *** $1 FAILED — nothing written for this table ***"; return 1; }
  echo
}

# ---------------------------------------------------------------- documents
want documents && run_step documents "
begin;
create temp table s (id uuid primary key, doi text, title text, title_en text,
  year_published integer, publication_title text, article_type text, wri_primary_office text,
  status text, authors text, url text, date_published date, metadata_source jsonb,
  updated_at timestamptz);
\\copy s from '$WORK/documents.csv' with (format csv)
select 'source_rows', count(*)::text from s;
select 'id_match', count(*)::text from s join documents d on d.id=s.id;
select 'will_change', count(*)::text from s join documents d on d.id=s.id
 where (d.doi,d.title,d.title_en,d.year_published,d.publication_title,d.article_type,
        d.wri_primary_office,d.status,d.authors,d.url,d.date_published,d.metadata_source,d.updated_at)
    is distinct from (s.doi,s.title,s.title_en,s.year_published,s.publication_title,s.article_type,
        s.wri_primary_office,s.status,s.authors,s.url,s.date_published,s.metadata_source,s.updated_at);
select 'status_transition', d.status||' -> '||s.status||' ('||count(*)::text||')'
  from s join documents d on d.id=s.id where d.status is distinct from s.status
 group by d.status, s.status order by 1;
update documents d set doi=s.doi, title=s.title, title_en=s.title_en,
  year_published=s.year_published, publication_title=s.publication_title,
  article_type=s.article_type, wri_primary_office=s.wri_primary_office, status=s.status,
  authors=s.authors, url=s.url, date_published=s.date_published,
  metadata_source=s.metadata_source, updated_at=s.updated_at
 from s where d.id=s.id
   and (d.doi,d.title,d.title_en,d.year_published,d.publication_title,d.article_type,
        d.wri_primary_office,d.status,d.authors,d.url,d.date_published,d.metadata_source,d.updated_at)
    is distinct from (s.doi,s.title,s.title_en,s.year_published,s.publication_title,s.article_type,
        s.wri_primary_office,s.status,s.authors,s.url,s.date_published,s.metadata_source,s.updated_at);
select 'remaining_diffs', count(*)::text from s join documents d on d.id=s.id
 where (d.doi,d.title,d.title_en,d.year_published,d.publication_title,d.article_type,
        d.wri_primary_office,d.status,d.authors,d.url,d.date_published,d.metadata_source,d.updated_at)
    is distinct from (s.doi,s.title,s.title_en,s.year_published,s.publication_title,s.article_type,
        s.wri_primary_office,s.status,s.authors,s.url,s.date_published,s.metadata_source,s.updated_at);
$END"

# ---------------------------------------------------------------- summaries
want summaries && run_step summaries "
begin;
create temp table s (document_id uuid, language text, kind text, text text,
  source text, model_version text);
\\copy s from '$WORK/summaries.csv' with (format csv)
select 'source_rows', count(*)::text from s;
select 'will_change', count(*)::text from s
  join document_summaries t on t.document_id=s.document_id and t.language=s.language and t.kind=s.kind
 where (t.text,t.source,t.model_version) is distinct from (s.text,s.source,s.model_version);
update document_summaries t set text=s.text, source=s.source, model_version=s.model_version
  from s where t.document_id=s.document_id and t.language=s.language and t.kind=s.kind
   and (t.text,t.source,t.model_version) is distinct from (s.text,s.source,s.model_version);
select 'remaining_diffs', count(*)::text from s
  join document_summaries t on t.document_id=s.document_id and t.language=s.language and t.kind=s.kind
 where (t.text,t.source,t.model_version) is distinct from (s.text,s.source,s.model_version);
$END"

# ---------------------------------------------------------------- chunks
# NB: (document_id, chunk_index) has no unique constraint behind it. Verified unique in
# practice on both sides; the guard below keeps that from becoming a silent assumption.
want chunks && run_step chunks "
begin;
create temp table s (document_id uuid, chunk_index integer, text text,
  embedding_t text, sparse_t text, corpus_order integer);
\\copy s from '$WORK/chunks.csv' with (format csv)
do \$\$ declare n int; begin
  select count(*) into n from (select document_id, chunk_index from document_chunks
    group by 1,2 having count(*)>1) x;
  if n <> 0 then raise exception 'GUARD: % duplicate (document_id,chunk_index) keys on target', n; end if;
end \$\$;
select 'source_rows', count(*)::text from s;
select 'will_change', count(*)::text from s
  join document_chunks c on c.document_id=s.document_id and c.chunk_index=s.chunk_index
 where (c.text,c.embedding::text,c.sparse::text,c.corpus_order)
    is distinct from (s.text,s.embedding_t,s.sparse_t,s.corpus_order);
update document_chunks c set text=s.text, embedding=s.embedding_t::vector,
  sparse=s.sparse_t::sparsevec, corpus_order=s.corpus_order
  from s where c.document_id=s.document_id and c.chunk_index=s.chunk_index
   and (c.text,c.embedding::text,c.sparse::text,c.corpus_order)
    is distinct from (s.text,s.embedding_t,s.sparse_t,s.corpus_order);
select 'remaining_diffs', count(*)::text from s
  join document_chunks c on c.document_id=s.document_id and c.chunk_index=s.chunk_index
 where (c.text,c.embedding::text,c.sparse::text,c.corpus_order)
    is distinct from (s.text,s.embedding_t,s.sparse_t,s.corpus_order);
select 'null_vectors_after', (select count(*) from document_chunks where embedding is null
  or sparse is null)::text;
$END"

# ---------------------------------------------------------------- relations
want relations && run_step relations "
begin;
create temp table s (id uuid, document_id uuid, related_document_id uuid, relation_type text,
  status text, source text, confidence numeric, signals jsonb, created_at timestamptz,
  reviewed_by text, reviewed_at timestamptz);
\\copy s from '$WORK/relations.csv' with (format csv)
select 'source_rows', count(*)::text from s;
select 'target_before', count(*)::text from document_relations;
-- The 2026-09-19 target was empty, but this script is meant to be reused. A future
-- production with locally-created relations would lose them to a blind delete — the
-- same failure shape as H1 in the runbook.
select 'target_rows_absent_from_qa', count(*)::text from document_relations r
 where not exists (select 1 from s where s.id=r.id);
do \$\$ declare n int; begin
  select count(*) into n from document_relations r where not exists (select 1 from s where s.id=r.id);
  if n <> 0 then raise exception
    'GUARD: % production document_relations rows do not exist in qa and would be destroyed', n; end if;
end \$\$;
delete from document_relations;
insert into document_relations (id, document_id, related_document_id, relation_type, status,
  source, confidence, signals, created_at, reviewed_by, reviewed_at)
select id, document_id, related_document_id, relation_type, status, source, confidence,
  signals, created_at, reviewed_by, reviewed_at from s;
select 'target_after', count(*)::text from document_relations;
select 'by_status', status||'='||count(*)::text from document_relations group by status order by 1;
$END"

# ---------------------------------------------------------------- taxonomy
want tags && run_step taxonomy "
begin;
do \$\$ declare n int; begin
  select count(*) into n from document_tags dt join tags t on t.id=dt.tag_id
   where t.facet='geography';
  if n <> 0 then raise exception
    'GUARD: % document_tags reference geography tags; the DELETE would cascade them away', n; end if;
end \$\$;
select 'tags_before', count(*)::text from tags;
delete from tags where facet='geography' and taxonomy_version='v1';
create temp table s (id uuid primary key, facet text, value_id text, taxonomy_version text,
  parent_tag_id uuid, description text, needs_reembed boolean);
\\copy s from '$WORK/tags.csv' with (format csv)
do \$\$ declare n int; begin
  select count(*) into n from tags t where not exists (select 1 from s where s.id=t.id);
  if n <> 0 then raise exception 'GUARD: % production tags absent from qa would be orphaned', n; end if;
end \$\$;
-- one statement: the parent_tag_id self-FK is checked at end of statement, so ordering is free
insert into tags (id, facet, value_id, taxonomy_version, parent_tag_id, description, needs_reembed)
select id, facet, value_id, taxonomy_version, parent_tag_id, description, needs_reembed from s
on conflict (id) do update set facet=excluded.facet, value_id=excluded.value_id,
  taxonomy_version=excluded.taxonomy_version, parent_tag_id=excluded.parent_tag_id,
  description=excluded.description, needs_reembed=excluded.needs_reembed;
select 'tags_after', count(*)::text from tags;
select 'by_facet', facet||'='||count(*)::text from tags group by facet order by 1;
delete from tag_aliases;
\\copy tag_aliases (tag_id, alias, created_at) from '$WORK/tag_aliases.csv' with (format csv)
select 'tag_aliases', count(*)::text from tag_aliases;
delete from tag_embeddings;
create temp table te (tag_id uuid, embedding_model text, dimension integer, embedding_t text,
  embedded_text text, embedded_at timestamptz);
\\copy te from '$WORK/tag_embeddings.csv' with (format csv)
insert into tag_embeddings (tag_id, embedding_model, dimension, embedding, embedded_text, embedded_at)
select tag_id, embedding_model, dimension, embedding_t::vector, embedded_text, embedded_at from te;
select 'tag_embeddings', count(*)::text from tag_embeddings;
-- THE GATE THAT KEEPS THE WORKER QUIET. build_all_embeddings fires on a MISSING
-- tag_embeddings row, not on needs_reembed. If this is not 0, restoring the worker
-- starts a Bedrock wave.
select 'GATE_unembedded_topic_geo', count(*)::text from tags t
 where t.facet in ('topic','geography') and t.taxonomy_version='v1'
   and not exists (select 1 from tag_embeddings e where e.tag_id=t.id);
select 'needs_reembed_true', count(*)::text from tags where needs_reembed;
$END"

# ---------------------------------------------------------------- document_tags
want doc_tags && run_step document_tags "
begin;
create temp table s (document_id uuid, tag_id uuid, source text, confidence numeric,
  model_version text, status text, created_at timestamptz);
\\copy s from '$WORK/document_tags.csv' with (format csv)
select 'source_rows', count(*)::text from s;
select 'target_before', count(*)::text from document_tags;
select 'prod_only_by_source', dt.source||'='||count(*)::text from document_tags dt
 where not exists (select 1 from s where s.document_id=dt.document_id and s.tag_id=dt.tag_id)
 group by dt.source order by 1;
do \$\$ declare n int; begin
  select count(*) into n from document_tags dt where dt.source='human'
   and not exists (select 1 from s where s.document_id=dt.document_id and s.tag_id=dt.tag_id);
  if n <> 0 then raise exception 'GUARD: % human rows would be deleted — never allowed', n; end if;
end \$\$;
do \$\$ declare n int; begin
  select count(*) into n from document_tags dt where dt.source='external'
   and not exists (select 1 from s where s.document_id=dt.document_id and s.tag_id=dt.tag_id);
  if n <> $ALLOW_EXT then raise exception
    'GUARD: % external rows would be deleted, --allow-external-deletes is $ALLOW_EXT', n; end if;
end \$\$;
-- Deletion is not the only way to destroy a human row. The upsert below rewrites
-- source/confidence/model_version/status on every shared key, so a pair that is
-- 'human' on production and 'llm' on qa would be silently demoted. CLAUDE.md:
-- never modify a document_tags row with source='human'.
select 'human_rows_qa_would_overwrite', count(*)::text from document_tags dt
  join s on s.document_id=dt.document_id and s.tag_id=dt.tag_id
 where dt.source='human' and s.source is distinct from 'human';
do \$\$ declare n int; begin
  select count(*) into n from document_tags dt
    join s on s.document_id=dt.document_id and s.tag_id=dt.tag_id
   where dt.source='human' and s.source is distinct from 'human';
  if n <> 0 then raise exception
    'GUARD: % production human rows would be overwritten with a non-human source', n; end if;
end \$\$;
delete from document_tags dt
 where not exists (select 1 from s where s.document_id=dt.document_id and s.tag_id=dt.tag_id);
insert into document_tags (document_id, tag_id, source, confidence, model_version, status, created_at)
select document_id, tag_id, source, confidence, model_version, status, created_at from s
on conflict (document_id, tag_id) do update set source=excluded.source,
  confidence=excluded.confidence, model_version=excluded.model_version,
  status=excluded.status, created_at=excluded.created_at
-- belt and braces: even if the guard above is ever removed, a human row can only be
-- updated by another human row.
where document_tags.source is distinct from 'human' or excluded.source = 'human';
select 'target_after', count(*)::text from document_tags;
select 'by_source', source||'='||count(*)::text from document_tags group by source order by 1;
select 'rows_on_one_side_only', count(*)::text from (
  select document_id, tag_id from document_tags
  except select document_id, tag_id from s
  union all
  select document_id, tag_id from s
  except select document_id, tag_id from document_tags) x;
$END"

echo "=== $MODE complete ==="
if [ "$APPLY" -eq 0 ]; then
  cat <<'NOTE'

This was a DRY RUN. Every statement ran and was rolled back; the counts above are exact.
Re-run with --apply to commit.
NOTE
else
  cat <<'NOTE'

Committed. Next, in this order:
  1. ./scripts/with-remote-env.sh production bash -c 'cd search-service && ./venv/bin/python -m scripts.build_search_vocab'
  2. ./scripts/fingerprint-corpus.sh production qa     # all gated objects must MATCH
  3. Deploy (merge the release PR), then verify, then restore BOTH workers.
NOTE
fi
