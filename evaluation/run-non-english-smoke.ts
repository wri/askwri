/**
 * Non-English keyword-lane smoke runner.
 *
 * For each query in non-english-smoke.json, calls /query (cite mode) with
 * return_intermediate_results=true and records where the target doc(s) first
 * appear in each lane: BM25-only, dense-only, and the final fused+reranked
 * docs. Used to compare keyword-lane candidates before/after replacement.
 *
 * Usage: npx tsx evaluation/run-non-english-smoke.ts [--label baseline]
 * (search-service must be running; see CLAUDE.md)
 */
import * as fs from 'fs';
import * as path from 'path';
import { PYTHON_SERVICE_URL } from './lib/service-client';

interface SmokeQuery {
  id: string;
  language: string;
  query: string;
  target_doc_ids: string[];
  note?: string;
}

interface LaneRanks {
  bm25_rank: number | null;
  dense_rank: number | null;
  final_rank: number | null;
  bm25_top5: string[];
  latency_ms: number;
}

function docRank(results: { doc_id: string }[], targets: string[]): number | null {
  // Chunk-level lists: dedupe to doc-level order, return 1-based rank of first target hit.
  const seen = new Set<string>();
  let rank = 0;
  for (const r of results) {
    if (seen.has(r.doc_id)) continue;
    seen.add(r.doc_id);
    rank += 1;
    if (targets.includes(r.doc_id)) return rank;
  }
  return null;
}

function docOrder(results: { doc_id: string }[], n: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of results) {
    if (seen.has(r.doc_id)) continue;
    seen.add(r.doc_id);
    out.push(r.doc_id);
    if (out.length >= n) break;
  }
  return out;
}

async function main() {
  const labelIdx = process.argv.indexOf('--label');
  const label = labelIdx >= 0 ? process.argv[labelIdx + 1] : 'run';
  const smokePath = path.join(__dirname, 'non-english-smoke.json');
  const smoke = JSON.parse(fs.readFileSync(smokePath, 'utf-8'));
  const queries: SmokeQuery[] = smoke.queries;

  const results: Record<string, LaneRanks & { query: string; language: string }> = {};
  let bm25Hits = 0;
  let denseHits = 0;
  let finalHits = 0;

  for (const q of queries) {
    const started = Date.now();
    const res = await fetch(`${PYTHON_SERVICE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: q.query,
        mode: 'cite',
        max_results: 150,
        return_intermediate_results: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`/query failed for ${q.id}: HTTP ${res.status}`);
    }
    const data = await res.json();
    const latency = Date.now() - started;

    const bm25Rank = docRank(data.bm25_results || [], q.target_doc_ids);
    const denseRank = docRank(data.vector_results || [], q.target_doc_ids);
    const finalRank = (() => {
      const idx = (data.docs || []).findIndex((d: { doc_id: string }) =>
        q.target_doc_ids.includes(d.doc_id),
      );
      return idx >= 0 ? idx + 1 : null;
    })();

    if (bm25Rank !== null) bm25Hits += 1;
    if (denseRank !== null) denseHits += 1;
    if (finalRank !== null) finalHits += 1;

    results[q.id] = {
      query: q.query,
      language: q.language,
      bm25_rank: bm25Rank,
      dense_rank: denseRank,
      final_rank: finalRank,
      bm25_top5: docOrder(data.bm25_results || [], 5),
      latency_ms: latency,
    };
    console.log(
      `${q.id}  bm25=${bm25Rank ?? '-'}  dense=${denseRank ?? '-'}  final=${finalRank ?? '-'}  (${latency}ms)  ${q.query}`,
    );
  }

  const summary = {
    label,
    timestamp: new Date().toISOString(),
    totals: {
      queries: queries.length,
      bm25_target_found: bm25Hits,
      dense_target_found: denseHits,
      final_target_found: finalHits,
    },
    results,
  };
  const outPath = path.join(__dirname, 'results', `non-english-smoke-${label}-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nBM25 lane found target: ${bm25Hits}/${queries.length}`);
  console.log(`Dense lane found target: ${denseHits}/${queries.length}`);
  console.log(`Final docs found target: ${finalHits}/${queries.length}`);
  console.log(`Saved ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
