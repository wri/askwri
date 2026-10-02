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
const REPS = Number(arg('reps', '1'))
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

type Record_ = {
  document_id: string
  title: string
  gold: string
  goldInCandidates: boolean
  picks: Record<string, Pick & { ms: number }>
}

async function main() {
  assertUsableGold(FACET, await loadGold(FACET))

  // Only documents that have gold can be scored, so restrict to those.
  const rows = await loadRows({ facet: FACET, topN: TOP_N, limit: LIMIT, onlyWithGold: true })

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
  const summary = active.map((s) => {
    const picks = results.map((r) => r.picks[s.id])
    const correct = results.filter((r) => r.picks[s.id].label === r.gold)
    const correctInRecall = scored.filter((r) => r.picks[s.id].label === r.gold)
    const withConf = results.filter((r) => r.picks[s.id].confidence !== null)
    const brier = withConf.length
      ? withConf.reduce(
          (acc, r) => acc + (r.picks[s.id].confidence! - (r.picks[s.id].label === r.gold ? 1 : 0)) ** 2,
          0,
        ) / withConf.length
      : null
    const goldMass = (() => {
      const probs = results.filter((r) => r.picks[s.id].probabilities)
      if (!probs.length) return null
      return (
        probs.reduce((acc, r) => acc + (r.picks[s.id].probabilities![r.gold] ?? 0), 0) / probs.length
      )
    })()
    const perPass = passes.map(
      (p) => p.filter((r) => r.picks[s.id].label === r.gold).length / p.length,
    )
    return {
      id: s.id,
      note: s.note,
      n: results.length,
      errors: picks.filter((p) => p.label === null).length,
      top1: correct.length / results.length,
      top1InRecall: scored.length ? correctInRecall.length / scored.length : 0,
      accuracy: correct.length,
      meanConf: withConf.length
        ? withConf.reduce((a, r) => a + r.picks[s.id].confidence!, 0) / withConf.length
        : null,
      brier,
      goldMass,
      perPass,
      top1Min: Math.min(...perPass),
      top1Max: Math.max(...perPass),
      meanMs: picks.reduce((a, p) => a + p.ms, 0) / picks.length,
    }
  })

  // reliability bins over self-reported confidence
  const bins = active
    .filter((s) => results.some((r) => r.picks[s.id].confidence !== null))
    .map((s) => {
      const edges = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01]
      const table = edges.slice(0, -1).map((lo, i) => {
        const hi = edges[i + 1]
        const inBin = results.filter((r) => {
          const c = r.picks[s.id].confidence
          return c !== null && c >= lo && c < hi
        })
        return {
          band: `${lo.toFixed(2)}–${hi === 1.01 ? '1.00' : hi.toFixed(2)}`,
          n: inBin.length,
          meanConf: inBin.length
            ? inBin.reduce((a, r) => a + r.picks[s.id].confidence!, 0) / inBin.length
            : null,
          accuracy: inBin.length
            ? inBin.filter((r) => r.picks[s.id].label === r.gold).length / inBin.length
            : null,
        }
      })
      return { id: s.id, table }
    })

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
