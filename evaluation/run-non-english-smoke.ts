/**
 * Non-English keyword-lane smoke runner.
 *
 * For each query in non-english-smoke.json, calls /query (cite mode) with
 * return_intermediate_results=true and records where the target doc(s) first
 * appear in each lane: BM25-only, dense-only, and the fused doc list.
 * rerank=false: lane comparison doesn't need the cross-encoder, and skipping
 * it turns ~3min/query (CPU rerank of a 500-candidate pool) into seconds.
 * Used to compare keyword-lane candidates before/after replacement.
 *
 * Usage: npx tsx evaluation/run-non-english-smoke.ts [--label baseline] [--rerank]
 * (search-service must be running; see CLAUDE.md)
 *
 * --rerank: exercise the full cite pipeline (cross-encoder + logit floor +
 * tiers) instead of lane comparison. Records the target's post-rerank doc
 * rank, its relevance tier, and how many docs survived the floor. Used to
 * compare rerankers/floors before/after a model swap (Phase B, multilingual
 * spec 2026-07-07).
 */
import * as fs from 'fs'
import * as path from 'path'
import { PYTHON_SERVICE_URL } from './lib/service-client'

interface SmokeQuery {
  id: string
  language: string
  query: string
  target_doc_ids: string[]
  note?: string
  defect?: string
  defect_target_doc_ids?: string[]
}

interface LaneRanks {
  bm25_rank: number | null
  dense_rank: number | null
  final_rank: number | null
  bm25_top5: string[]
  latency_ms: number
  // --rerank only:
  target_tier?: string | null
  docs_after_floor?: number
}

function docRank(
  results: { doc_id: string }[],
  targets: string[],
): number | null {
  // Chunk-level lists: dedupe to doc-level order, return 1-based rank of first target hit.
  const seen = new Set<string>()
  let rank = 0
  for (const r of results) {
    if (seen.has(r.doc_id)) continue
    seen.add(r.doc_id)
    rank += 1
    if (targets.includes(r.doc_id)) return rank
  }
  return null
}

function docOrder(results: { doc_id: string }[], n: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of results) {
    if (seen.has(r.doc_id)) continue
    seen.add(r.doc_id)
    out.push(r.doc_id)
    if (out.length >= n) break
  }
  return out
}

async function main() {
  const labelIdx = process.argv.indexOf('--label')
  const label = labelIdx >= 0 ? process.argv[labelIdx + 1] : 'run'
  const rerank = process.argv.includes('--rerank')
  const smokePath = path.join(__dirname, 'non-english-smoke.json')
  const smoke = JSON.parse(fs.readFileSync(smokePath, 'utf-8'))
  // Defect handling is per-TARGET: a query with one bad target keeps its
  // valid ones (nq-es-01: _2705 is language='en' on qa, _9471 is genuinely
  // es); the query drops only when no valid target remains (nq-pt-02).
  const queries: SmokeQuery[] = smoke.queries
    .map((q: SmokeQuery) => ({
      ...q,
      target_doc_ids: q.target_doc_ids.filter(
        (id) => !(q.defect_target_doc_ids ?? []).includes(id),
      ),
    }))
    .filter((q: SmokeQuery) => {
      if (q.defect && q.target_doc_ids.length === 0) {
        console.log(`skip ${q.id}: ${q.defect.slice(0, 60)}…`)
        return false
      }
      if (q.defect) {
        console.log(
          `${q.id}: defective target(s) removed, ${q.target_doc_ids.length} valid kept`,
        )
      }
      return true
    })

  const results: Record<
    string,
    LaneRanks & { query: string; language: string }
  > = {}
  let bm25Hits = 0
  let denseHits = 0
  let finalHits = 0

  for (const q of queries) {
    const started = Date.now()
    const res = await fetch(`${PYTHON_SERVICE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: q.query,
        mode: 'cite',
        max_results: 150,
        rerank,
        return_intermediate_results: true,
      }),
    })
    if (!res.ok) {
      throw new Error(`/query failed for ${q.id}: HTTP ${res.status}`)
    }
    const data = await res.json()
    const latency = Date.now() - started

    const bm25Rank = docRank(data.bm25_results || [], q.target_doc_ids)
    const denseRank = docRank(data.vector_results || [], q.target_doc_ids)
    const finalRank = (() => {
      const idx = (data.docs || []).findIndex((d: { doc_id: string }) =>
        q.target_doc_ids.includes(d.doc_id),
      )
      return idx >= 0 ? idx + 1 : null
    })()

    if (bm25Rank !== null) bm25Hits += 1
    if (denseRank !== null) denseHits += 1
    if (finalRank !== null) finalHits += 1

    const targetDoc = (data.docs || []).find((d: { doc_id: string }) =>
      q.target_doc_ids.includes(d.doc_id),
    )
    results[q.id] = {
      query: q.query,
      language: q.language,
      bm25_rank: bm25Rank,
      dense_rank: denseRank,
      final_rank: finalRank,
      bm25_top5: docOrder(data.bm25_results || [], 5),
      latency_ms: latency,
      ...(rerank
        ? {
            target_tier: targetDoc?.metadata?.relevance_tier ?? null,
            docs_after_floor: data.total_results,
          }
        : {}),
    }
    const rerankInfo = rerank
      ? `  tier=${targetDoc?.metadata?.relevance_tier ?? '-'}  floor_docs=${data.total_results}`
      : ''
    console.log(
      `${q.id}  bm25=${bm25Rank ?? '-'}  dense=${denseRank ?? '-'}  final=${finalRank ?? '-'}${rerankInfo}  (${latency}ms)  ${q.query}`,
    )
  }

  const summary = {
    label,
    rerank,
    timestamp: new Date().toISOString(),
    totals: {
      queries: queries.length,
      bm25_target_found: bm25Hits,
      dense_target_found: denseHits,
      final_target_found: finalHits,
    },
    results,
  }
  const outPath = path.join(
    __dirname,
    'results',
    `non-english-smoke-${label}-${Date.now()}.json`,
  )
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2))
  console.log(`\nBM25 lane found target: ${bm25Hits}/${queries.length}`)
  console.log(`Dense lane found target: ${denseHits}/${queries.length}`)
  console.log(`Final docs found target: ${finalHits}/${queries.length}`)
  console.log(`Saved ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
