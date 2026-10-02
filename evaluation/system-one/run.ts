/**
 * System One eval harness — single-label classification against a facet's
 * legacy `external` tags.
 *
 * The reference labels are whatever `document_tags.source = 'external'` holds
 * (exactly one per document per facet). These are NOT ground truth: they were
 * force-applied across the founding corpus and never verified. Varied on
 * `office`/`doc_type`, degenerate on `topic`/`program`. Results measure
 * agreement with a legacy assignment, not correctness — see README.md.
 *
 * Nothing here needs labelling work or an LLM judge.
 *
 * Every system sees the identical state (the document basis the worker uses),
 * the identical question, and the identical candidate set, so differences are
 * the model's alone.
 *
 * Usage:
 *   ./scripts/with-remote-env.sh qa npx tsx evaluation/system-one/run.ts --facet topic
 *   ./scripts/with-remote-env.sh qa npx tsx evaluation/system-one/run.ts --facet program --limit 20
 *   ./scripts/with-remote-env.sh qa npx tsx evaluation/system-one/run.ts --systems llm:gpt-5.6-luna,systemone:kev-4b
 *
 * Requires SYSTEMONE_API_KEY (or LUNAROUTE_API_KEY) and OPENAI_API_KEY.
 *
 * See README.md for adding a model variant.
 */
import { writeFileSync } from 'node:fs'
import {
  type Pick,
  type PickCtx,
  type System,
  defaultSystems,
  systemsFromIds,
} from './systems'
import { pool, type Row, loadGold, loadRows, assertUsableGold, facetHasEmbeddings } from './dataset'
import { summariseSystems, reliabilityBins, type ScoredRow } from './scoring'

// ── args ────────────────────────────────────────────────────────────────────

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  if (!v || v.startsWith('--')) throw new Error(`--${name} needs a value`)
  return v
}

const FACET = arg('facet', 'topic')!
const TOP_N = Number(arg('top-n', '20'))
const LIMIT = arg('limit') ? Number(arg('limit')) : null
const CONCURRENCY = Number(arg('concurrency', '4'))
const ONLY = arg('systems')
// Clamped: 0, negative or non-numeric values used to produce an empty pass list
// and then NaN/Infinity throughout the report and the committed artifact.
const REPS = Math.max(1, Math.floor(Number(arg('reps', '1')) || 1))
const OUT =
  arg('out') ??
  `evaluation/system-one/results-${new Date().toISOString().slice(0, 10)}-${FACET}.json`

// One instruction string, identical for every system and every document.
const QUESTION =
  `Which single ${FACET} value is this document's primary ${FACET}? ` +
  `Answer with exactly one of the candidate values.`

const systems: System[] = ONLY ? systemsFromIds(ONLY.split(',')) : defaultSystems()

// ── data ────────────────────────────────────────────────────────────────────

/** Run `limit` tasks at a time; keeps the provider from being flooded. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

// ── run ─────────────────────────────────────────────────────────────────────

type Record_ = ScoredRow

async function main() {
  assertUsableGold(FACET, await loadGold(FACET))

  // Only documents that have gold can be scored, so restrict to those.
  const rows = await loadRows({ facet: FACET, topN: TOP_N, limit: LIMIT, onlyWithGold: true })
  if (!rows.length) {
    throw new Error(
      `no scorable documents for facet '${FACET}' — all skipped (missing basis or candidate set)`,
    )
  }

  // The embedding baseline only means something when the facet is embedded.
  const embedded = await facetHasEmbeddings(FACET)
  const active = embedded ? systems : systems.filter((s) => !s.id.startsWith('embedding:'))

  const ctxOf = (r: Row): PickCtx => ({ state: r.basis, question: QUESTION, candidates: r.candidates })

  async function onePass(): Promise<Record_[]> {
    return mapPool(rows, CONCURRENCY, async (r): Promise<Record_> => {
      const entries = await Promise.all(
        active.map(async (s) => {
          const started = Date.now()
          try {
            const pick = await s.pick(ctxOf(r))
            return [s.id, { ...pick, ms: Date.now() - started }] as const
          } catch (e) {
            return [s.id, { label: null, confidence: null, error: String(e), ms: Date.now() - started }] as const
          }
        }),
      )
      return {
        document_id: r.document_id,
        title: r.title,
        gold: r.gold!,
        goldInCandidates: r.candidates.some((c) => c.label === r.gold),
        picks: Object.fromEntries(entries),
      }
    })
  }

  // Each repetition is an independent sample per document, so scoring runs over
  // documents × repetitions. Per-pass accuracy is kept separately: that spread,
  // not the pooled mean, is what says whether a gap between systems is real.
  const passes: Record_[][] = []
  for (let i = 0; i < REPS; i++) passes.push(await onePass())
  const results = passes.flat()

  const recall = results.filter((r) => r.goldInCandidates).length / results.length
  const scored = results.filter((r) => r.goldInCandidates)

  // ── score ─────────────────────────────────────────────────────────────────
  const summary = summariseSystems({ systems: active, results, scored, passes })

  const bins = reliabilityBins(active, results)

  // ── report ────────────────────────────────────────────────────────────────
  const pct = (x: number) => (x * 100).toFixed(1).padStart(5) + '%'
  const num = (x: number | null, d = 3) => (x === null ? '    —' : x.toFixed(d).padStart(6))

  console.log(`\nfacet=${FACET}  docs=${rows.length}  passes=${REPS}  top-n=${TOP_N}`)
  console.log(`question="${QUESTION}"`)
  console.log(
    `gold = document_tags.source='external' (WRI metadata, one value per document)\n` +
      (embedded
        ? `candidates = retrieve-then-classify, top ${TOP_N} by cosine. `
        : `candidates = full ${FACET} vocabulary (no tag embeddings for this facet). `) +
      `candidate recall (gold inside the candidate set): ${pct(recall)}  →  ceiling for any candidate-based system`,
  )

  console.log(
    `\n${'system'.padEnd(28)} ${'n'.padStart(4)} ${'err'.padStart(4)} ${'top1'.padStart(6)} ${'top1|cand'.padStart(10)} ${'Brier'.padStart(7)} ${'meanConf'.padStart(9)} ${'p(gold)'.padStart(8)} ${'ms'.padStart(7)}`,
  )
  console.log('─'.repeat(96))
  for (const s of summary) {
    console.log(
      `${s.id.padEnd(28)} ${String(s.n).padStart(4)} ${String(s.errors).padStart(4)} ` +
        `${pct(s.top1)} ${pct(s.top1InRecall).padStart(10)} ${num(s.brier)} ${num(s.meanConf)} ${num(s.goldMass)} ${s.meanMs.toFixed(0).padStart(7)}`,
    )
  }

  if (REPS > 1) {
    console.log(`\nper-pass top1 (each pass is an independent sample over all documents)`)
    for (const s of summary) {
      console.log(`${s.id.padEnd(28)} ${s.perPass.map((x) => pct(x)).join('  ')}`)
    }
  }

  for (const b of bins) {
    console.log(`\nreliability — ${b.id}`)
    console.log(`${'band'.padEnd(12)} ${'n'.padStart(4)} ${'meanConf'.padStart(9)} ${'accuracy'.padStart(9)}`)
    for (const r of b.table) {
      if (!r.n) continue
      console.log(
        `${r.band.padEnd(12)} ${String(r.n).padStart(4)} ${num(r.meanConf)} ${pct(r.accuracy!).padStart(9)}`,
      )
    }
  }

  const artifact = {
    harness: 'evaluation/system-one',
    ranAt: new Date().toISOString(),
    facet: FACET,
    topN: TOP_N,
    reps: REPS,
    question: QUESTION,
    candidateRecall: recall,
    systems: active.map((s) => ({ id: s.id, note: s.note })),
    summary,
    reliability: bins,
    results,
  }
  writeFileSync(OUT, JSON.stringify(artifact, null, 2))
  console.log(`\nwrote ${OUT}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => pool.end())
