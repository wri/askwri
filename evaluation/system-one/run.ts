/**
 * System One eval harness — single-label classification against a facet's
 * authoritative `external` tags.
 *
 * The gold set is the tag WRI's own metadata assigns to each document
 * (`document_tags.source = 'external'`, exactly one per document per facet).
 * It needs no labelling work and no LLM judge.
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
import { Pool } from 'pg'
import { writeFileSync } from 'node:fs'
import {
  type Candidate,
  type Pick,
  type PickCtx,
  type System,
  defaultSystems,
  systemsFromIds,
} from './systems'

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
const OUT =
  arg('out') ??
  `evaluation/system-one/results-${new Date().toISOString().slice(0, 10)}-${FACET}.json`

// One instruction string, identical for every system and every document.
const QUESTION =
  `Which single ${FACET} value is this document's primary ${FACET}? ` +
  `Answer with exactly one of the candidate values.`

const systems: System[] = ONLY ? systemsFromIds(ONLY.split(',')) : defaultSystems()

// ── data ────────────────────────────────────────────────────────────────────

type Row = {
  document_id: string
  title: string
  basis: string
  gold: string
  candidates: Candidate[]
}

// Same SSL contract as src/db/data-source.ts: DATABASE_SSL=false for a local
// docker database, DATABASE_SSL_REJECT_UNAUTHORIZED=false to match what libpq's
// `require` does against RDS (encrypt, don't verify).
const pool = new Pool({
  ssl:
    process.env.DATABASE_SSL === 'false'
      ? false
      : { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' },
})

async function loadGold(): Promise<Array<{ document_id: string; gold: string }>> {
  const { rows } = await pool.query(
    `SELECT dt.document_id, t.value_id AS gold
       FROM document_tags dt
       JOIN tags t ON t.id = dt.tag_id
      WHERE dt.source = 'external' AND t.facet = $1
      ORDER BY dt.document_id`,
    [FACET],
  )
  if (!rows.length) {
    throw new Error(
      `no source='external' gold rows for facet '${FACET}' — measure office or doc_type`,
    )
  }

  // Guard against a facet whose "gold" is one constant. `topic` and `program`
  // are exactly that on this corpus (a single portfolio stamp smeared over a
  // batch), so every model scores ~0% against a target that says nothing about
  // the document. Refusing here beats reporting a number someone misreads as a
  // broken model.
  const distinct = new Set(rows.map((r) => r.gold))
  if (distinct.size < 3) {
    throw new Error(
      `facet '${FACET}' has only ${distinct.size} distinct external value(s) ` +
        `(${[...distinct].join(', ')}) — that is a batch stamp, not a label set, ` +
        `and no model can score above chance against it.\n` +
        `Measurable facets on this corpus: office (9 values), doc_type (7 values).`,
    )
  }

  return rows
}

/** The document basis, exactly as worker/stages/classify.py builds it. */
async function loadBasis(documentId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT COALESCE(
              (SELECT text FROM document_summaries
                WHERE document_id = $1 AND language = 'en' AND kind = 'long'),
              (SELECT left(full_text, 8000) FROM document_texts WHERE document_id = $1)
            ) AS basis`,
    [documentId],
  )
  return rows[0]?.basis ?? null
}

/**
 * Whether a facet has tag embeddings. Only the embedded facets (`topic`,
 * `geography`) do; everything else is classified against the full vocabulary in
 * production, so the harness falls back to enumerating every value.
 */
async function facetHasEmbeddings(facet: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM tag_embeddings te
       JOIN tags t ON t.id = te.tag_id
      WHERE t.facet = $1 AND t.taxonomy_version = 'v1'
        AND te.embedding_model = 'cohere-embed-v4'
      LIMIT 1`,
    [facet],
  )
  return rows.length > 0
}

/**
 * Candidate tags for a document.
 *
 * Embedded facets: the top-N tags by cosine distance from the stored
 * summary-chunk embedding (cohere-embed-v4, the same model that built
 * `tag_embeddings`). This mirrors the worker's retrieve-then-classify exactly,
 * except the document vector is read from the summary chunk rather than
 * re-embedded, which keeps the harness free of a Bedrock dependency.
 *
 * Non-embedded facets: the whole v1 vocabulary, which is what the worker does
 * for them. `distance` is meaningless and stays null.
 */
async function loadCandidates(
  documentId: string,
  embedded: boolean,
): Promise<Candidate[]> {
  if (!embedded) {
    const { rows } = await pool.query(
      `SELECT t.value_id AS label, t.description,
              COALESCE((SELECT array_agg(a.alias) FROM tag_aliases a WHERE a.tag_id = t.id),
                       '{}'::text[]) AS aliases
         FROM tags t
        WHERE t.facet = $1 AND t.taxonomy_version = 'v1'
        ORDER BY t.value_id
        LIMIT $2`,
      [FACET, TOP_N],
    )
    return rows.map((r) => ({
      label: r.label,
      description: r.description,
      aliases: r.aliases ?? [],
      distance: 0,
    }))
  }

  const { rows } = await pool.query(
    `WITH dv AS (
       SELECT embedding FROM document_chunks
        WHERE document_id = $1
          AND unit_type = 'summary'
          AND embedding_model = 'cohere-embed-v4'
        LIMIT 1
     )
     SELECT t.value_id AS label,
            t.description,
            COALESCE((SELECT array_agg(a.alias) FROM tag_aliases a WHERE a.tag_id = t.id),
                     '{}'::text[]) AS aliases,
            te.embedding <=> (SELECT embedding FROM dv) AS distance
       FROM tag_embeddings te
       JOIN tags t ON t.id = te.tag_id
      WHERE t.facet = $2
        AND t.taxonomy_version = 'v1'
        AND te.embedding_model = 'cohere-embed-v4'
      ORDER BY distance
      LIMIT $3`,
    [documentId, FACET, TOP_N],
  )
  return rows.map((r) => ({
    label: r.label,
    description: r.description,
    aliases: r.aliases ?? [],
    distance: Number(r.distance),
  }))
}

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
  const gold = await loadGold()
  const sample = LIMIT ? gold.slice(0, LIMIT) : gold
  const embedded = await facetHasEmbeddings(FACET)

  // The embedding baseline only means something when the facet is embedded.
  const active = embedded ? systems : systems.filter((s) => !s.id.startsWith('embedding:'))

  const rows: Row[] = []
  for (const g of sample) {
    const [basis, candidates] = await Promise.all([
      loadBasis(g.document_id),
      loadCandidates(g.document_id, embedded),
    ])
    if (!basis || !candidates.length) {
      console.warn(`skip ${g.document_id}: ${!basis ? 'no basis' : 'no candidates'}`)
      continue
    }
    const title =
      (await pool.query('SELECT title FROM documents WHERE id = $1', [g.document_id])).rows[0]
        ?.title ?? ''
    rows.push({ document_id: g.document_id, title, basis, gold: g.gold, candidates })
  }

  const ctxOf = (r: Row): PickCtx => ({ state: r.basis, question: QUESTION, candidates: r.candidates })

  const results = await mapPool(rows, CONCURRENCY, async (r): Promise<Record_> => {
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
      gold: r.gold,
      goldInCandidates: r.candidates.some((c) => c.label === r.gold),
      picks: Object.fromEntries(entries),
    }
  })

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

  console.log(`\nfacet=${FACET}  docs=${results.length}  top-n=${TOP_N}  question="${QUESTION}"`)
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
