/**
 * Cross-lingual probe runner (spec 2026-07-26 L0.2).
 *
 * Reads evaluation/cross-lingual-en.json and, per query, records where each
 * target doc (and each english_competitor, for en-topical) lands: bm25 lane,
 * dense lane, fused list (rerank=false default), or the final reranked list
 * (--rerank). Writes evaluation/results/cross-lingual-probe-<label>.json.
 *
 * This is a DIRECTIONAL instrument: n=39, agent-authored, unreviewed
 * (the file's own caveats). It reports BEFORE/AFTER deltas via --compare;
 * it has NO pass/fail thresholds by design. Do not add any.
 *
 * Pinned parameters (single-harness rule — postmortem 2026-07-24 rule 7):
 * vector_top_k=800, bm25_top_k=800, rerank_top_n=500, max_results=100 —
 * the run-cite-eval.ts parameter set, so probe numbers and cite-eval numbers
 * come from the same retrieval configuration.
 *
 * Usage:
 *   npx tsx evaluation/run-cross-lingual-probe.ts --label before [--rerank]
 *   npx tsx evaluation/run-cross-lingual-probe.ts --compare before after
 * (search-service must be running; see CLAUDE.md)
 */
import * as fs from 'fs';
import * as path from 'path';
import { PYTHON_SERVICE_URL } from './lib/service-client';

const PINNED = { vector_top_k: 800, bm25_top_k: 800, rerank_top_n: 500, max_results: 100 };

interface ProbeQuery {
  id: string;
  class: 'en-tr' | 'en-body' | 'en-topical';
  query: string;
  target_doc_ids: string[];
  english_competitors?: string[];
  defect?: string;
}

interface DocRanks {
  bm25: number | null;
  dense: number | null;
  final: number | null;
}

interface ProbeResult {
  class: string;
  query: string;
  targets: Record<string, DocRanks>;
  competitors?: Record<string, DocRanks>;
  final_doc_count: number;
  latency_ms: number;
}

function rankOf(results: { doc_id: string }[] | undefined, docId: string): number | null {
  if (!results) return null;
  const seen = new Set<string>();
  let rank = 0;
  for (const r of results) {
    if (seen.has(r.doc_id)) continue;
    seen.add(r.doc_id);
    rank += 1;
    if (r.doc_id === docId) return rank;
  }
  return null;
}

async function runProbe(label: string, rerank: boolean) {
  const probePath = path.join(__dirname, 'cross-lingual-en.json');
  const probeSet = JSON.parse(fs.readFileSync(probePath, 'utf-8'));
  const queries: ProbeQuery[] = probeSet.queries.filter((q: ProbeQuery) => {
    if (q.defect) console.log(`skip ${q.id}: ${q.defect.slice(0, 60)}…`);
    return !q.defect;
  });

  const results: Record<string, ProbeResult> = {};
  for (const q of queries) {
    const started = Date.now();
    const res = await fetch(`${PYTHON_SERVICE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: q.query,
        mode: 'cite',
        rerank,
        return_intermediate_results: true,
        ...PINNED,
      }),
    });
    if (!res.ok) throw new Error(`${q.id}: ${res.status} ${await res.text()}`);
    const data = await res.json();
    // Matches run-non-english-smoke.ts: bm25_results / vector_results / docs
    // are already { doc_id: string, ... }[] — no metadata wrapper to unwrap.
    const finalDocs: { doc_id: string }[] = data.docs || [];
    const bm25: { doc_id: string }[] = data.bm25_results || [];
    const dense: { doc_id: string }[] = data.vector_results || [];

    const ranks = (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, {
        bm25: rankOf(bm25, id), dense: rankOf(dense, id), final: rankOf(finalDocs, id),
      }]));

    results[q.id] = {
      class: q.class,
      query: q.query,
      targets: ranks(q.target_doc_ids),
      ...(q.english_competitors ? { competitors: ranks(q.english_competitors) } : {}),
      final_doc_count: finalDocs.length,
      latency_ms: Date.now() - started,
    };
    const t = Object.entries(results[q.id].targets)
      .map(([id, r]) => `${id.slice(-4)}: bm25=${r.bm25 ?? '—'} dense=${r.dense ?? '—'} final=${r.final ?? '—'}`)
      .join('  ');
    console.log(`${q.id} [${q.class}] ${t}`);
  }

  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `cross-lingual-probe-${label}.json`);
  fs.writeFileSync(out, JSON.stringify({
    label, rerank, pinned: PINNED, generated_at: new Date().toISOString(),
    service_url: PYTHON_SERVICE_URL, results,
  }, null, 2));
  console.log(`\nwrote ${out}  (${Object.keys(results).length} queries)`);
}

function compare(a: string, b: string) {
  const load = (l: string) =>
    JSON.parse(fs.readFileSync(path.join(__dirname, 'results', `cross-lingual-probe-${l}.json`), 'utf-8'));
  const A = load(a), B = load(b);
  console.log(`Δ ${a} → ${b}   (negative Δ = improved rank; '—' = absent)`);
  for (const id of Object.keys(A.results)) {
    if (!B.results[id]) continue;
    for (const kind of ['targets', 'competitors'] as const) {
      const ra = A.results[id][kind], rb = B.results[id][kind];
      if (!ra || !rb) continue;
      for (const doc of Object.keys(ra)) {
        const rankA = ra[doc], rankB = rb[doc];
        if (!rankB) continue;
        // Diff ALL three lanes (bm25/dense/final), not just the final fused
        // rank — a lane can shift without moving the final rank (review I6).
        if (rankA.bm25 === rankB.bm25 && rankA.dense === rankB.dense && rankA.final === rankB.final) continue;
        const tag = kind === 'competitors' ? ' [competitor]' : '';
        const col = (name: 'bm25' | 'dense' | 'final') =>
          `${name} ${rankA[name] ?? '—'}→${rankB[name] ?? '—'}`;
        console.log(`${id}${tag} ${doc}: ${col('bm25')}  ${col('dense')}  ${col('final')}`);
      }
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const ci = argv.indexOf('--compare');
  if (ci >= 0) return compare(argv[ci + 1], argv[ci + 2]);
  const li = argv.indexOf('--label');
  await runProbe(li >= 0 ? argv[li + 1] : 'run', argv.includes('--rerank'));
}

main().catch((e) => { console.error(e); process.exit(1); });
