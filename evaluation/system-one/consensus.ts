/**
 * Generator consensus — silver labels, and the validation of the method.
 *
 * Runs several strong models over the same documents and reports how much they
 * agree. Where the facet has varied legacy reference labels (`office`,
 * `doc_type`) it also measures
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
import {
  defaultGenerators,
  defaultMultiGenerators,
  multiSystemsFromIds,
  systemsFromIds,
  type MultiPick,
  type Pick,
  type System,
} from './systems'
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
const MODE = (arg('mode', 'choice') as 'choice' | 'noul')
// Production accepts a tag at confidence >= tag_confidence_accept (0.7).
const THRESHOLD = Number(arg('threshold', '0.7'))
// Production attaches up to 5 tags per document.
const TOP_K = Number(arg('top-k', '5'))
const OUT =
  arg('out') ??
  `evaluation/system-one/silver-${new Date().toISOString().slice(0, 10)}-${FACET}-top${TOP_N}.jsonl`

// Built inside mainChoice: at module load the mode is unknown, and `--generators`
// may name multi-label kinds (jev, cosine) that systemsFromIds does not handle.

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

async function mainChoice() {
  const generators: System[] = GENERATORS ? systemsFromIds(GENERATORS.split(',')) : defaultGenerators()
  const goldMap = await loadGold(FACET)
  const goldDistinct = new Set(goldMap.values())
  const goldUsable = goldDistinct.size >= 3
  // When the facet has varying legacy labels, score only documents that HAVE
  // one. A row without a label scores as a miss in every denominator otherwise:
  // on office that silently deflated accuracy by ~18 points (65.9% vs 83.3%).
  const rows = await loadRows({
    facet: FACET,
    topN: TOP_N,
    limit: LIMIT,
    onlyWithGold: goldUsable,
  })
  if (!rows.length) {
    throw new Error(`no documents for facet '${FACET}' — all skipped (missing basis or candidate set)`)
  }
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
      // Gold comes from the map, not from r.gold: rows are loaded unrestricted
      // so the consensus can run on facets that have no gold at all.
      gold: goldMap.get(r.document_id) ?? null,
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
  // Strict majority of a full answer set. The threshold has to scale with the
  // generator count, and two earlier attempts did not: `>= ids.length - 1`
  // counted a 1-1 split as agreement with two generators, and `=== ids.length - 1`
  // counted *only* disagreements. At two generators this means both must agree,
  // at four it means three or more, which is what "all but one" was meant to say.
  const majorityNeeded = Math.floor(ids.length / 2) + 1
  const majorityAgree = results.filter((r) => {
    const u = usableOf(r)
    if (u.length !== ids.length) return false
    const counts = new Map<string, number>()
    for (const l of u) counts.set(l, (counts.get(l) ?? 0) + 1)
    return Math.max(...counts.values()) >= majorityNeeded
  })

  console.log(
    `\nagreement\n` +
      `   unanimous (all ${ids.length}):      ${unanimous.length}/${results.length}  ${((unanimous.length / results.length) * 100).toFixed(0)}%\n` +
      `   at least ${majorityNeeded} of ${ids.length} agree:  ${majorityAgree.length}/${results.length}  ${((majorityAgree.length / results.length) * 100).toFixed(0)}%`,
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
    console.log(`\nper-generator agreement vs the legacy reference labels`)
    for (const id of ids) {
      const answered = results.filter((r) => r.picks[id]?.label)
      const right = answered.filter((r) => r.picks[id].label === r.gold)
      const fails = results.length - answered.length
      console.log(
        `   ${id.padEnd(38)} ${((right.length / results.length) * 100).toFixed(1).padStart(5)}%  ` +
          `(${right.length}/${results.length}${fails ? `, ${fails} failed` : ''})`,
      )
    }
    const uniq = unanimous.filter((r) => r.gold)
    const uRight = uniq.filter((r) => usableOf(r)[0] === r.gold)
    console.log(
      `   ${'UNANIMOUS label'.padEnd(38)} ${((uRight.length / uniq.length) * 100).toFixed(1).padStart(5)}%  ` +
        `(${uRight.length}/${uniq.length})  ← what a unanimous silver label is worth`,
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
  // Only documents where every generator answered. A row built from the two
  // models that replied would be written as a usable `majority-2of4` label,
  // indistinguishable downstream from a real majority. The noul writer already
  // skipped these; the choice writer did not.
  const completeRows = results.filter((r) => usableOf(r).length === ids.length)
  const lines = completeRows.map((r) => {
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
  if (completeRows.length < results.length) {
    console.log(
      `\n   ${results.length - completeRows.length} document(s) omitted from the label file: ` +
        `a generator failed there, so agreement is undefined`,
    )
  }

  const artifact = {
    harness: 'evaluation/system-one/consensus',
    ranAt: new Date().toISOString(),
    facet: FACET,
    topN: TOP_N,
    question: QUESTION,
    documents: results.length,
    documentsLabelled: completeRows.length,
    candidatesPerDoc: rows[0]?.candidates.length ?? 0,
    goldNote,
    generators: generators.map((g) => ({ id: g.id, family: family(g.id), note: g.note })),
    unanimous: unanimous.length,
    // Names the actual rule: a strict majority of a full answer set. At two
    // generators that is 2-of-2, which `unanimous` already reports, so this is
    // only informative at three or more.
    agreementMajority: majorityAgree.length,
    sameFamilyAgreementPct: rate(sameFam),
    crossFamilyAgreementPct: rate(crossFam),
    pairs,
    results,
  }
  writeFileSync(OUT.replace(/\.jsonl$/, '.summary.json'), JSON.stringify(artifact, null, 2))
  console.log(`\nwrote ${OUT}`)
  console.log(`wrote ${OUT.replace(/\.jsonl$/, '.summary.json')}`)
}

// ── noul mode: per-tag probabilities, the shape production would deploy ────

type NoulResult = {
  document_id: string
  title: string
  gold: string | null
  candidateLabels: string[]
  scores: Record<string, MultiPick & { ms: number }>
}

/** Tags a generator judged to apply, at the accept threshold. */
function acceptedSet(scores: Record<string, number> | undefined, labels: string[]): Set<string> {
  const out = new Set<string>()
  if (!scores) return out
  for (const l of labels) if ((scores[l] ?? 0) >= THRESHOLD) out.add(l)
  return out
}

/** The generator's own top-K by probability — production's "top 5 most relevant". */
function topKSet(scores: Record<string, number> | undefined, labels: string[], k: number): Set<string> {
  if (!scores) return new Set()
  return new Set(
    labels
      .filter((l) => l in scores)
      .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))
      .slice(0, k),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b])
  if (!union.size) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / union.size
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

async function mainNoul() {
  const rows = await loadRows({ facet: FACET, topN: TOP_N, limit: LIMIT, onlyWithGold: false })
  if (!rows.length) {
    throw new Error(`no documents for facet '${FACET}' — all skipped (missing basis or candidate set)`)
  }
  // The reference labels are loaded regardless of onlyWithGold so every label
  // row can carry them where the facet has them — that is what checks the label.
  const goldMap = await loadGold(FACET)
  const generators = GENERATORS ? multiSystemsFromIds(GENERATORS.split(',')) : defaultMultiGenerators()
  const ids = generators.map((g) => g.id)

  console.log(`\nfacet=${FACET}  docs=${rows.length}  candidates=${rows[0]?.candidates.length ?? 0}`)
  console.log(`mode=noul  accept threshold=${THRESHOLD}  top-k=${TOP_K}`)
  console.log(`generators:`)
  for (const g of generators) console.log(`   ${g.id.padEnd(38)} ${g.note}`)

  const results = await mapPool(rows, CONCURRENCY, async (r): Promise<NoulResult> => {
    const entries = await Promise.all(
      generators.map(async (g) => {
        const started = Date.now()
        try {
          const p = await g.apply(r.basis, r.candidates)
          return [g.id, { ...p, ms: Date.now() - started }] as const
        } catch (e) {
          return [g.id, { scores: {}, error: String(e), ms: Date.now() - started }] as const
        }
      }),
    )
    return {
      document_id: r.document_id,
      title: r.title,
      gold: goldMap.get(r.document_id) ?? null,
      candidateLabels: r.candidates.map((c) => c.label),
      scores: Object.fromEntries(entries),
    }
  })

  // Documents where every generator answered. Everything below aggregates over
  // this set only: a failure or a half-scored batch would otherwise enter the
  // agreement statistics as "this generator accepts nothing" — indistinguishable
  // from a real answer — and would let "unanimous" mean "the two that replied
  // agreed". The per-tag yes-rate and pair table skip missing cells already, so
  // the two reporting paths used to disagree about the same failure.
  const complete = results.filter((r) => ids.every((id) => !r.scores[id]?.error))
  const skipped = results.length - complete.length

  // ── failures ──────────────────────────────────────────────────────────────
  // Printed before the emptiness guard below: this breakdown is what an operator
  // needs precisely when everything failed.
  console.log(`\nfailures`)
  for (const id of ids) {
    const bad = results.filter((r) => r.scores[id]?.error)
    console.log(
      `   ${id.padEnd(38)} ${bad.length}/${results.length}` +
        (bad.length ? `   e.g. ${bad[0].scores[id].error!.slice(0, 80)}` : ''),
    )
  }

  // Guarding rows.length is not enough: every generator can fail on every
  // document, and then `exact / complete.length` is 0/0 and the report and
  // artifact fill with NaN instead of failing. Raised after the breakdown above
  // so the per-generator errors are still on screen.
  if (!complete.length) {
    throw new Error(
      `every generator failed on all ${results.length} document(s) for facet '${FACET}' — nothing to aggregate`,
    )
  }

  // ── set agreement at the accept threshold ────────────────────────────────
  const setsAt = (r: NoulResult, id: string) => acceptedSet(r.scores[id]?.scores, r.candidateLabels)
  const topsAt = (r: NoulResult, id: string) => topKSet(r.scores[id]?.scores, r.candidateLabels, TOP_K)

  const score = (label: string, setOf: (r: NoulResult, id: string) => Set<string>) => {
    const perGen = ids.map((id) => mean(complete.map((r) => setOf(r, id).size)))
    const exact = complete.filter((r) => {
      const sets = ids.map((id) => setOf(r, id))
      return sets.every((s) => s.size === sets[0].size && [...s].every((x) => sets[0].has(x)))
    }).length
    const pairJ: number[] = []
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        pairJ.push(mean(complete.map((r) => jaccard(setOf(r, ids[i]), setOf(r, ids[j])))))
    console.log(`\n${label}`)
    console.log(
      `   sets per document:  ${perGen.map((n, i) => `${ids[i].split(':').pop()}=${n.toFixed(1)}`).join('  ')}`,
    )
    console.log(
      `   identical set across all ${ids.length}:  ${exact}/${complete.length}  ${((exact / complete.length) * 100).toFixed(0)}%`,
    )
    console.log(`   mean pairwise Jaccard:            ${mean(pairJ).toFixed(3)}`)
    return { exact, meanJaccard: mean(pairJ), meanSetSize: perGen }
  }

  const atThreshold = score(`sets at accept threshold ${THRESHOLD}`, setsAt)
  const atTopK = score(`top-${TOP_K} by probability`, topsAt)

  // ── agreed core vs union ────────────────────────────────────────────────
  // Tags every generator accepts, as a share of the tags any of them raised.
  // An earlier commit quoted 55/126 = 0.44 by hand; the harness did not compute
  // it, so the artifact could not reproduce its own headline figure.
  let coreTags = 0
  let unionTags = 0
  for (const r of complete) {
    const sets = ids.map((id) => setsAt(r, id))
    const union = new Set<string>()
    for (const s of sets) for (const t of s) union.add(t)
    for (const t of union) {
      unionTags++
      if (sets.every((s) => s.has(t))) coreTags++
    }
  }
  console.log(
    `\nagreed core vs union (accept threshold ${THRESHOLD})\n` +
      `   tags all ${ids.length} accept: ${coreTags}   tags any accepts: ${unionTags}` +
      (unionTags ? `   core/union = ${(coreTags / unionTags).toFixed(2)}` : ''),
  )

  // ── per-tag binary agreement, and the family split on it ─────────────────
  console.log(`\nper-tag binary agreement (all document x tag cells)`)
  const yesRate = ids.map((id) => {
    let yes = 0
    let cells = 0
    for (const r of complete)
      for (const l of r.candidateLabels) {
        const s = r.scores[id]?.scores
        if (!s || !(l in s)) continue
        cells++
        if (s[l] >= THRESHOLD) yes++
      }
    return cells ? yes / cells : 0
  })
  ids.forEach((id, i) =>
    console.log(`   ${id.padEnd(38)} says yes to ${(yesRate[i] * 100).toFixed(1)}% of cells`),
  )

  const pairTable: Array<{ a: string; b: string; same: boolean; agree: number }> = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const cells: number[] = []
      for (const r of complete) {
        const sa = r.scores[ids[i]]?.scores
        const sb = r.scores[ids[j]]?.scores
        for (const l of r.candidateLabels) {
          if (!sa || !sb || !(l in sa) || !(l in sb)) continue
          cells.push((sa[l] >= THRESHOLD) === (sb[l] >= THRESHOLD) ? 1 : 0)
        }
      }
      pairTable.push({ a: ids[i], b: ids[j], same: family(ids[i]) === family(ids[j]), agree: mean(cells) })
    }
  }
  console.log(`\npairwise binary agreement`)
  for (const p of pairTable) {
    console.log(
      `   ${p.a.padEnd(38)} x ${p.b.padEnd(38)} ${(p.agree * 100).toFixed(1)}%${p.same ? '   [same family]' : ''}`,
    )
  }
  const same = pairTable.filter((p) => p.same)
  const cross = pairTable.filter((p) => !p.same)
  console.log(
    `\nfamily effect\n` +
      `   same-family:  ${same.length ? (mean(same.map((p) => p.agree)) * 100).toFixed(1) : '—'}%\n` +
      `   cross-family: ${cross.length ? (mean(cross.map((p) => p.agree)) * 100).toFixed(1) : '—'}%`,
  )

  // ── per document view for small batches ──────────────────────────────────
  if (results.length <= 25) {
    console.log(`\nper document (tags accepted at ${THRESHOLD})`)
    for (const r of results) {
      const sets = ids.map((id) => [...setsAt(r, id)].sort())
      const allSame = sets.every((s) => JSON.stringify(s) === JSON.stringify(sets[0]))
      console.log(`\n  ${r.title.slice(0, 66)}${allSame ? '   IDENTICAL' : ''}`)
      ids.forEach((id, i) =>
        console.log(`     ${id.split(':').pop()!.padEnd(26)} ${sets[i].join(' | ') || '—'}`),
      )
    }
  }

  const artifact = {
    harness: 'evaluation/system-one/consensus',
    mode: 'noul',
    ranAt: new Date().toISOString(),
    facet: FACET,
    topN: TOP_N,
    threshold: THRESHOLD,
    topK: TOP_K,
    documents: results.length,
    documentsComplete: complete.length,
    documentsSkipped: skipped,
    agreedCoreTags: coreTags,
    unionTags,
    candidatesPerDoc: rows[0]?.candidates.length ?? 0,
    generators: generators.map((g) => ({ id: g.id, family: family(g.id), note: g.note })),
    atThreshold,
    atTopK,
    yesRate,
    pairTable,
    results,
  }
  const out = OUT.replace(/\.jsonl$/, '') + '.noul.json'
  writeFileSync(out, JSON.stringify(artifact, null, 2))
  console.log(`\nwrote ${out}`)

  // ── silver labels ─────────────────────────────────────────────────────────
  const majorityNeeded = Math.floor(ids.length / 2) + 1

  const labelLines = complete.map((r) => {
    const votes: Record<string, number> = {}
    const probs: Record<string, number[]> = {}
    const perGenerator: Record<string, string[]> = {}

    for (const id of ids) {
      const s = r.scores[id]?.scores
      const accepted: string[] = []
      if (s) {
        for (const l of r.candidateLabels) {
          if (!(l in s)) continue
          ;(probs[l] ??= []).push(s[l])
          if (s[l] >= THRESHOLD) {
            votes[l] = (votes[l] ?? 0) + 1
            accepted.push(l)
          }
        }
      }
      perGenerator[id] = accepted.sort()
    }

    const meanP = (l: string) => mean(probs[l] ?? [])
    const agreed = Object.keys(votes).filter((l) => votes[l] >= majorityNeeded)
    // Production attaches the TOP_K most relevant tags, so cap the label the
    // same way rather than shipping however many cleared the threshold.
    const silver = [...agreed].sort((a, b) => meanP(b) - meanP(a)).slice(0, TOP_K)
    const core = Object.keys(votes).filter((l) => votes[l] === ids.length)
    // Accepted by at least one generator but not a majority: the human queue.
    const disputed = Object.keys(votes)
      .filter((l) => votes[l] >= 1 && votes[l] < majorityNeeded)
      .sort((a, b) => votes[b] - votes[a] || meanP(b) - meanP(a))

    const sets = ids.map((id) => JSON.stringify(perGenerator[id]))
    // An all-empty set is not agreement: every generator accepting nothing is
    // four models saying "no tag applies", which must not count as unanimity and
    // inflate the agreement statistics.
    const agreement =
      new Set(sets).size === 1 && silver.length
        ? 'unanimous'
        : silver.length
          ? `majority-${Math.max(...silver.map((l) => votes[l]))}of${ids.length}`
          : 'no-consensus'

    return JSON.stringify({
      document_id: r.document_id,
      title: r.title,
      facet: FACET,
      // The label. Empty means the generators did not agree on a majority set.
      silver_tags: silver,
      unanimous_tags: core,
      disputed_tags: disputed,
      votes: Object.fromEntries(Object.entries(votes).sort((a, b) => b[1] - a[1])),
      mean_probability: Object.fromEntries(
        Object.keys(votes).map((l) => [l, Number(meanP(l).toFixed(4))]),
      ),
      per_generator: perGenerator,
      agreement,
      external_gold: r.gold,
      // Everything needed to reproduce or distrust this label.
      provenance: {
        threshold: THRESHOLD,
        top_k: TOP_K,
        candidates_per_doc: r.candidateLabels.length,
        majority_needed: majorityNeeded,
        generators: generators.map((g) => ({ id: g.id, family: family(g.id), note: g.note })),
        generated_at: new Date().toISOString(),
        not_ground_truth: 'model consensus, not human labels',
        validated_against: 'see results-*/office consensus run for the measured error rate',
      },
    })
  })

  const labelsOut = OUT.replace(/\.jsonl$/, '') + '.labels.jsonl'
  writeFileSync(labelsOut, labelLines.join('\n') + '\n')

  const withLabel = (() => {
    let n = 0
    for (const l of labelLines) if (JSON.parse(l).silver_tags.length) n++
    return n
  })()
  const unanimous = labelLines.filter((l) => JSON.parse(l).agreement === 'unanimous').length
  const contestedTags = labelLines.reduce(
    (a, l) => a + JSON.parse(l).disputed_tags.length,
    0,
  )
  console.log(
    `\nsilver labels\n` +
      `   documents with a label:      ${withLabel}/${complete.length}` +
      (skipped ? `  (+${skipped} skipped: a generator failed, so agreement is undefined)` : '') +
      `\n   sets identical across all ${ids.length}: ${unanimous}/${complete.length}` +
      `\n   tags sent to the human queue: ${contestedTags}\n` +
      `wrote ${labelsOut}`,
  )
}

const run = MODE === 'noul' ? mainNoul : mainChoice

run()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => pool.end())
