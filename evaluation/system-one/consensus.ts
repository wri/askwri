/**
 * Generator consensus — silver labels, and the validation of the method.
 *
 * Runs several strong models over the same documents and reports how much they
 * agree. Where the facet has real gold (`office`, `doc_type`) it also measures
 * each generator against it, which is the only way to know what a unanimous
 * label is actually worth.
 *
 * Generators must NOT be among the systems under test, or the winner is decided
 * by construction. `defaultGenerators()` enforces that by construction.
 *
 * Usage:
 *   ./scripts/with-remote-env.sh qa npx tsx evaluation/system-one/consensus.ts --facet topic --limit 15
 *   ./scripts/with-remote-env.sh qa npx tsx evaluation/system-one/consensus.ts --facet topic --top-n 757
 *   ./scripts/with-remote-env.sh qa npx tsx evaluation/system-one/consensus.ts --facet office
 *
 * Requires OPENAI_API_KEY, SYSTEMONE_API_KEY (or LUNAROUTE_API_KEY), and a live
 * AWS session for the Bedrock generators.
 */
import { writeFileSync } from 'node:fs'
import { defaultGenerators, systemsFromIds, type Pick, type System } from './systems'
import { pool, loadRows, loadGold } from './dataset'

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
const GENERATORS = arg('generators')
const INSTRUCTION = arg('instruction')
const OUT =
  arg('out') ??
  `evaluation/system-one/silver-${new Date().toISOString().slice(0, 10)}-${FACET}-top${TOP_N}.jsonl`

const generators: System[] = GENERATORS ? systemsFromIds(GENERATORS.split(',')) : defaultGenerators()

// Overridable via --instruction so question variants can be compared on the
// identical documents. The default is deliberately silent about granularity —
// testing whether that silence, rather than the models, drives disagreement.
const QUESTION =
  INSTRUCTION ??
  `Which single ${FACET} value is this document's primary ${FACET}? ` +
    `Answer with exactly one of the candidate values.`

/** Which lab a generator is from. Consensus counts families, not models. */
function family(id: string): string {
  if (/anthropic|claude|opus|sonnet/i.test(id)) return 'anthropic'
  if (/glm|zhipu/i.test(id)) return 'zhipu'
  if (/deepseek/i.test(id)) return 'deepseek'
  if (/gpt|openai/i.test(id)) return 'openai'
  return id
}

type DocResult = {
  document_id: string
  title: string
  gold: string | null
  picks: Record<string, Pick & { ms: number }>
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

async function main() {
  const rows = await loadRows({ facet: FACET, topN: TOP_N, limit: LIMIT, onlyWithGold: false })
  const goldMap = await loadGold(FACET)
  const goldDistinct = new Set(goldMap.values())
  const goldUsable = goldDistinct.size >= 3
  // A facet with one gold value is a batch stamp, not a label set. Say so
  // rather than quietly reporting a meaningless accuracy.
  const goldNote = !goldMap.size
    ? 'none for this facet'
    : goldUsable
      ? `${goldDistinct.size} distinct values`
      : `${goldDistinct.size} distinct value (${[...goldDistinct][0]}) — a batch stamp, not scoreable`

  console.log(`\nfacet=${FACET}  docs=${rows.length}  candidates=${rows[0]?.candidates.length ?? 0}`)
  console.log(`gold: ${goldNote}`)
  console.log(`generators:`)
  for (const g of generators) console.log(`   ${g.id.padEnd(38)} ${g.note}`)

  const results = await mapPool(rows, CONCURRENCY, async (r): Promise<DocResult> => {
    const entries = await Promise.all(
      generators.map(async (g) => {
        const started = Date.now()
        try {
          const pick = await g.pick({
            state: r.basis,
            question: QUESTION,
            candidates: r.candidates,
          })
          return [g.id, { ...pick, ms: Date.now() - started }] as const
        } catch (e) {
          return [g.id, { label: null, confidence: null, error: String(e), ms: Date.now() - started }] as const
        }
      }),
    )
    return {
      document_id: r.document_id,
      title: r.title,
      gold: r.gold,
      picks: Object.fromEntries(entries),
    }
  })

  const ids = generators.map((g) => g.id)
  const usableOf = (r: DocResult) => ids.map((i) => r.picks[i]?.label).filter((l): l is string => !!l)

  // ── agreement ────────────────────────────────────────────────────────────
  const unanimous = results.filter((r) => {
    const u = usableOf(r)
    return u.length === ids.length && new Set(u).size === 1
  })
  const majority3 = results.filter((r) => {
    const u = usableOf(r)
    const counts = new Map<string, number>()
    for (const l of u) counts.set(l, (counts.get(l) ?? 0) + 1)
    return Math.max(...counts.values()) >= ids.length - 1
  })

  console.log(
    `\nagreement\n` +
      `   unanimous (all ${ids.length}):      ${unanimous.length}/${results.length}  ${((unanimous.length / results.length) * 100).toFixed(0)}%\n` +
      `   at least ${ids.length - 1} of ${ids.length} agree:  ${majority3.length}/${results.length}  ${((majority3.length / results.length) * 100).toFixed(0)}%`,
  )

  // pairwise agreement, and the same-family / cross-family split
  console.log(`\npairwise agreement (docs where both answered)`)
  const pairs: Array<{ a: string; b: string; same: boolean; n: number; agree: number }> = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const both = results.filter((r) => r.picks[ids[i]]?.label && r.picks[ids[j]]?.label)
      const agree = both.filter((r) => r.picks[ids[i]].label === r.picks[ids[j]].label)
      const rec = { a: ids[i], b: ids[j], same: family(ids[i]) === family(ids[j]), n: both.length, agree: agree.length }
      pairs.push(rec)
      const pct = both.length ? ((agree.length / both.length) * 100).toFixed(0) + '%' : '—'
      console.log(
        `   ${ids[i].padEnd(38)} x ${ids[j].padEnd(38)} ${pct.padStart(5)}  n=${both.length}${rec.same ? '   [same family]' : ''}`,
      )
    }
  }
  const sameFam = pairs.filter((p) => p.same)
  const crossFam = pairs.filter((p) => !p.same)
  const rate = (ps: typeof pairs) => {
    const n = ps.reduce((a, p) => a + p.n, 0)
    return n ? (ps.reduce((a, p) => a + p.agree, 0) / n) * 100 : null
  }
  console.log(
    `\nfamily effect\n` +
      `   same-family agreement:  ${rate(sameFam)?.toFixed(0) ?? '—'}%  (n=${sameFam.length} pair(s))\n` +
      `   cross-family agreement: ${rate(crossFam)?.toFixed(0) ?? '—'}%  (n=${crossFam.length} pair(s))` +
      (rate(sameFam) !== null && rate(crossFam) !== null
        ? `\n   → same-family models agree ${Math.abs(rate(sameFam)! - rate(crossFam)!).toFixed(0)} points ` +
          `${rate(sameFam)! > rate(crossFam)! ? 'MORE' : 'LESS'} than cross-family — ` +
          `${rate(sameFam)! > rate(crossFam)! ? 'discount Anthropic\'s two votes toward one' : 'no rubber-stamping detected; family votes need no discounting'}`
        : ''),
  )

  // ── per-generator, against gold where gold is real ────────────────────────
  if (goldUsable) {
    console.log(`\nper-generator accuracy vs gold (real gold on this facet)`)
    for (const id of ids) {
      const answered = results.filter((r) => r.picks[id]?.label)
      const right = answered.filter((r) => r.picks[id].label === r.gold)
      const fails = results.length - answered.length
      console.log(
        `   ${id.padEnd(38)} ${((right.length / results.length) * 100).toFixed(1).padStart(5)}%  ` +
          `(${right.length}/${results.length}${fails ? `, ${fails} failed` : ''})`,
      )
    }
    const uRight = unanimous.filter((r) => usableOf(r)[0] === r.gold)
    console.log(
      `   ${'UNANIMOUS label'.padEnd(38)} ${((uRight.length / results.length) * 100).toFixed(1).padStart(5)}%  ` +
        `(${uRight.length}/${results.length})  ← what a unanimous silver label is worth`,
    )
  }

  // ── per-document view for small batches ──────────────────────────────────
  if (results.length <= 25) {
    console.log(`\nper document`)
    for (const r of results) {
      const u = usableOf(r)
      const counts = new Map<string, number>()
      for (const l of u) counts.set(l, (counts.get(l) ?? 0) + 1)
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])
      const answered = u.length === ids.length ? '' : `  [${u.length}/${ids.length} answered]`
      const verdict =
        u.length === ids.length && new Set(u).size === 1
          ? 'UNANIMOUS'
          : `${u.length - (top[0]?.[1] ?? 0)} dissent`
      console.log(`\n  ${r.title.slice(0, 66)}` + `\n    gold=${r.gold ?? '—'}   ${verdict}${answered}`)
      for (const id of ids) {
        const p = r.picks[id]
        console.log(
          `      ${id.padEnd(38)} ${(p?.label ?? `FAILED: ${p?.error ?? '?'}`.slice(0, 40))}`,
        )
      }
    }
  }

  // ── write silver labels, with provenance ─────────────────────────────────
  const lines = results.map((r) => {
    const u = usableOf(r)
    const counts = new Map<string, number>()
    for (const l of u) counts.set(l, (counts.get(l) ?? 0) + 1)
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    return JSON.stringify({
      document_id: r.document_id,
      title: r.title,
      label: top?.[0] ?? null,
      agreement: u.length === ids.length && new Set(u).size === 1 ? 'unanimous' : `majority-${top?.[1] ?? 0}of${ids.length}`,
      n_answered: u.length,
      external_gold: r.gold,
      picks: Object.fromEntries(ids.map((i) => [i, r.picks[i]?.label ?? null])),
      errors: Object.fromEntries(
        ids.filter((i) => !r.picks[i]?.label).map((i) => [i, r.picks[i]?.error ?? 'unknown']),
      ),
      generators: generators.map((g) => ({ id: g.id, note: g.note })),
      generated_at: new Date().toISOString(),
      not_ground_truth: 'model consensus, not human labels',
    })
  })
  writeFileSync(OUT, lines.join('\n') + '\n')

  const artifact = {
    harness: 'evaluation/system-one/consensus',
    ranAt: new Date().toISOString(),
    facet: FACET,
    topN: TOP_N,
    question: QUESTION,
    documents: results.length,
    candidatesPerDoc: rows[0]?.candidates.length ?? 0,
    goldNote,
    generators: generators.map((g) => ({ id: g.id, family: family(g.id), note: g.note })),
    unanimous: unanimous.length,
    agreeAllButOne: majority3.length,
    sameFamilyAgreementPct: rate(sameFam),
    crossFamilyAgreementPct: rate(crossFam),
    pairs,
    results,
  }
  writeFileSync(OUT.replace(/\.jsonl$/, '.summary.json'), JSON.stringify(artifact, null, 2))
  console.log(`\nwrote ${OUT}`)
  console.log(`wrote ${OUT.replace(/\.jsonl$/, '.summary.json')}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => pool.end())
