#!/usr/bin/env bash
#
# fingerprint-corpus.sh — per-object content checksums for one environment.
#
# WHY THIS EXISTS
#   verify-corpus-parity.sh compares scalar COUNTS. It cannot see a document whose
#   chunk text or vectors diverged while the row count stayed the same — which is
#   exactly what happened before the 2026-09-19 release (two documents differed,
#   94 rows, invisible to every count-based probe).
#
#   This script emits content digests instead. Run it against both environments and
#   diff the output. Identical digests mean identical content, per object.
#
# USAGE
#   ./scripts/fingerprint-corpus.sh production            > before-prod.txt
#   ./scripts/fingerprint-corpus.sh qa                    > before-qa.txt
#   diff before-prod.txt before-qa.txt
#
#   ./scripts/fingerprint-corpus.sh production qa         # both, side by side, with a verdict
#
# THE INSTRUMENT RULE (CLAUDE.md: "fix the measurement instrument before measuring")
#   Some columns do not exist before a migration runs — `tags.description` arrives
#   with 1787160000000, so a digest including it is NOT computable pre-migration.
#   This script therefore emits TWO tag digests:
#     tags_identity  — (facet, value_id, taxonomy_version) only. Valid on ANY schema.
#                      Use this for a before/after comparison that spans a migration.
#     tags_full      — every column including id. Only comparable once BOTH sides
#                      have the same schema. Use this as the post-mirror parity gate.
#   Never compare a tags_identity digest against a tags_full one.
#
# EXPECTED BENIGN DIFFERENCES between qa and production
#   keyword_vocab  — canary documents ingested on one side add tokens. qa ⊂ prod is
#                    normal. Shared tokens MUST have identical df/idf (checked below).
#   search_vocab   — rebuilt per environment from live data; whichever was rebuilt
#                    most recently has more terms. Not a parity target.
#
set -euo pipefail

SQL="
select 'chunks', count(*)::text,
       md5(string_agg(md5(coalesce(text,'')||coalesce(sparse::text,'')||
                          coalesce(embedding::text,'')||coalesce(corpus_order::text,'')),
                      '' order by document_id, chunk_index))
  from document_chunks
union all select 'texts', count(*)::text,
       md5(string_agg(md5(to_jsonb(t)::text), '' order by document_id)) from document_texts t
union all select 'summaries', count(*)::text,
       md5(string_agg(md5(to_jsonb(s)::text), '' order by document_id, language, kind))
  from document_summaries s
union all select 'documents', count(*)::text,
       md5(string_agg(md5(to_jsonb(d)::text), '' order by external_id)) from documents d
union all select 'tags_identity', count(*)::text,
       md5(string_agg(md5(t2.facet||'|'||t2.value_id||'|'||t2.taxonomy_version),
                      '' order by t2.facet, t2.value_id, t2.taxonomy_version)) from tags t2
union all select 'doc_tags', count(*)::text,
       md5(string_agg(md5(dt.document_id::text||dt.tag_id::text||dt.source||dt.status||
                          coalesce(dt.confidence::text,'')),
                      '' order by dt.document_id, dt.tag_id)) from document_tags dt
union all select 'corpus_stats', count(*)::text,
       md5(string_agg(n_chunks::text||avgdl::text||k1::text||b::text||sparse_dim::text,''))
  from keyword_corpus_stats
union all select 'keyword_vocab', count(*)::text,
       md5(string_agg(md5(token||':'||df::text), '' order by token)) from keyword_vocab
"

# Objects that only exist after the TopicTaxonomy / GeographyFacet / SearchVocab
# migrations. Probed individually so this script works on either schema.
SQL_POST_MIGRATION="
select 'tags_full', count(*)::text,
       md5(string_agg(md5(t3.id::text||t3.facet||t3.value_id||t3.taxonomy_version||
                          coalesce(t3.parent_tag_id::text,'')||coalesce(t3.description,'')||
                          t3.needs_reembed::text), '' order by t3.facet, t3.value_id)) from tags t3
union all select 'tag_aliases', count(*)::text,
       md5(string_agg(md5(ta.tag_id::text||ta.alias), '' order by ta.tag_id, ta.alias))
  from tag_aliases ta
union all select 'tag_embeddings', count(*)::text,
       md5(string_agg(md5(te.tag_id::text||te.embedding_model||te.embedding::text),
                      '' order by te.tag_id, te.embedding_model)) from tag_embeddings te
union all select 'doc_relations', count(*)::text,
       md5(string_agg(md5(dr.document_id::text||dr.related_document_id::text||
                          dr.relation_type||dr.status),
                      '' order by dr.document_id, dr.related_document_id)) from document_relations dr
union all select 'search_vocab', count(*)::text, 'not-a-parity-target' from search_vocab
"

fingerprint_one() {
  local env="$1"
  ./scripts/with-remote-env.sh "$env" psql -X -t -A -F'|' -c "$SQL" 2>/dev/null | grep -v '^→'
  # Post-migration objects: skip cleanly if the tables are not there yet.
  if [ -n "$(./scripts/with-remote-env.sh "$env" psql -X -t -A \
              -c "select to_regclass('public.tag_embeddings')" 2>/dev/null | grep -v '^→')" ]; then
    ./scripts/with-remote-env.sh "$env" psql -X -t -A -F'|' -c "$SQL_POST_MIGRATION" 2>/dev/null | grep -v '^→'
  else
    echo "tags_full|-|(pre-migration: table columns absent)"
    echo "tag_aliases|-|(pre-migration: table absent)"
    echo "tag_embeddings|-|(pre-migration: table absent)"
    echo "doc_relations|-|(pre-migration: table absent)"
    echo "search_vocab|-|(pre-migration: table absent)"
  fi
}

if [ "$#" -eq 1 ]; then
  echo "# fingerprint: $1 @ $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fingerprint_one "$1"
  exit 0
fi

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <env>            # one environment, digests to stdout" >&2
  echo "       $0 <env-a> <env-b>  # compare two, with a verdict per object" >&2
  exit 64
fi

A="$1"; B="$2"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "# comparing $A vs $B @ $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fingerprint_one "$A" > "$TMP/a.txt"
fingerprint_one "$B" > "$TMP/b.txt"

printf '\n%-16s %10s %10s  %-34s %-34s %s\n' OBJECT "${A:0:10}" "${B:0:10}" "DIGEST($A)" "DIGEST($B)" VERDICT
mismatch=0
while IFS='|' read -r obj cnt_a dig_a; do
  line_b="$(grep "^${obj}|" "$TMP/b.txt" || true)"
  cnt_b="$(echo "$line_b" | cut -d'|' -f2)"
  dig_b="$(echo "$line_b" | cut -d'|' -f3)"
  if [ "$dig_a" = "$dig_b" ] && [ "$cnt_a" = "$cnt_b" ]; then
    verdict="MATCH"
  elif [ "$obj" = "keyword_vocab" ] || [ "$obj" = "search_vocab" ]; then
    verdict="differs (EXPECTED — see header)"
  else
    verdict="*** MISMATCH ***"; mismatch=$((mismatch+1))
  fi
  printf '%-16s %10s %10s  %-34s %-34s %s\n' "$obj" "$cnt_a" "$cnt_b" "${dig_a:0:32}" "${dig_b:0:32}" "$verdict"
done < "$TMP/a.txt"

echo
if [ "$mismatch" -eq 0 ]; then
  echo "RESULT: all gated objects match."
else
  echo "RESULT: $mismatch object(s) MISMATCH — do not treat this release as verified."
fi

# Shared-token df/idf check: the sparse lane's BM25 weights are frozen against these.
# A divergence here means copied sparse vectors score on a different scale.
echo
echo "# shared keyword_vocab tokens: df/idf must be identical on both sides"
for e in "$A" "$B"; do
  ./scripts/with-remote-env.sh "$e" psql -X -t -A \
    -c "select token||'|'||df::text||'|'||round(idf::numeric,6)::text from keyword_vocab order by token" \
    2>/dev/null | grep -v '^→' | LC_ALL=C sort > "$TMP/v-$e.txt"
done
shared=$(LC_ALL=C comm -12 <(cut -d'|' -f1 "$TMP/v-$A.txt") <(cut -d'|' -f1 "$TMP/v-$B.txt") | wc -l | tr -d ' ')
same=$(LC_ALL=C comm -12 "$TMP/v-$A.txt" "$TMP/v-$B.txt" | wc -l | tr -d ' ')
echo "shared tokens: $shared | identical df+idf: $same"
[ "$shared" = "$same" ] && echo "df/idf: OK — no BM25 scoring skew" \
                        || echo "df/idf: *** $((shared-same)) shared tokens differ — investigate before copying sparse vectors ***"

exit $(( mismatch > 0 ? 1 : 0 ))
