/**
 * Compare stage (§3.2 compare, §4.5 agreement, §4.6 pairwise): three
 * read-only views over stored artifacts.
 *
 * - `compareReports` — guarded side-by-side of two score reports (per-case
 *   deltas with the per-pass spread). The §6 guard is binding: a differing
 *   fixture commit, pass count, or case set refuses the comparison outright
 *   (throw) — never a delta over a mismatched pair.
 * - `judgedAgreement` — per-verdict-type agreement between two judged
 *   artifacts over the same capture, split by source language.
 * - `runPairwise` — order-swapped preference runs of capture A vs capture B
 *   answers over their SHARED passages, resumable by (case, pass) key like
 *   the judged artifact. A win counts only when it survives the order swap;
 *   split verdicts surface as position bias.
 */
import * as fs from 'fs'
import { resolveProvider } from '../../src/lib/llm/chat-completions'
import { loadEvalset } from './fixture'
import { judgeCall } from './judge-client'
import {
  PAIRWISE_SYSTEM,
  PROMPT_HASHES,
  pairwiseUser,
  validatePairwise,
} from './judge-prompts'
import { langOf } from './normalize'
import {
  CaptureArtifact,
  JudgedArtifact,
  JudgedItem,
  PassageSent,
  Report,
} from './types'

// ---------------------------------------------------------------------------
// §6 guard
// ---------------------------------------------------------------------------

interface Comparable {
  commit: string
  passes: number
  caseIds: string[]
}

/** Throws (never prints deltas) on any comparability mismatch. */
function guardPair(a: Comparable, b: Comparable, what: string): void {
  if (a.commit !== b.commit) {
    throw new Error(
      `refusing to ${what}: fixture commits differ (${a.commit} vs ${b.commit})`,
    )
  }
  if (a.passes !== b.passes) {
    throw new Error(
      `refusing to ${what}: pass counts differ (${a.passes} vs ${b.passes})`,
    )
  }
  const setA = new Set(a.caseIds)
  const setB = new Set(b.caseIds)
  const onlyA = [...new Set(a.caseIds.filter((id) => !setB.has(id)))]
  const onlyB = [...new Set(b.caseIds.filter((id) => !setA.has(id)))]
  if (onlyA.length > 0 || onlyB.length > 0) {
    throw new Error(
      `refusing to ${what}: case sets differ (only in first: ` +
        `${onlyA.join(', ') || 'none'}; only in second: ` +
        `${onlyB.join(', ') || 'none'})`,
    )
  }
}

// ---------------------------------------------------------------------------
// compareReports
// ---------------------------------------------------------------------------

/** Case-level metrics the score stage emits; passField maps to the
 * per_pass entry feeding each (abstention_rate ← per-pass abstained). */
const METRICS: Array<{ field: string; passField: string }> = [
  { field: 'evidence_coverage', passField: 'evidence_coverage' },
  { field: 'doc_map', passField: 'doc_map' },
  { field: 'attainable_recall', passField: 'attainable_recall' },
  { field: 'distinct_docs', passField: 'distinct_docs' },
  { field: 'top_doc_share', passField: 'top_doc_share' },
  { field: 'chunk_id_hit_rate', passField: 'chunk_id_hit_rate' },
  { field: 'fact_recall_strict', passField: 'fact_recall_strict' },
  { field: 'fact_recall_lenient', passField: 'fact_recall_lenient' },
  { field: 'citation_precision', passField: 'citation_precision' },
  { field: 'unsupported_claims_count', passField: 'unsupported_claims_count' },
  { field: 'unsupported_claims_rate', passField: 'unsupported_claims_rate' },
  { field: 'abstention_rate', passField: 'abstained' },
]

const fmtV = (v: unknown): string =>
  typeof v === 'number' ? v.toFixed(3) : 'n/a'

/** min–max across the case's per_pass values for one metric. */
function spread(
  passes: Array<Record<string, unknown>>,
  passField: string,
): string {
  const xs = passes
    .map((p) =>
      passField === 'abstained' ? (p.abstained ? 1 : 0) : p[passField],
    )
    .filter((v): v is number => typeof v === 'number')
  if (xs.length === 0) return 'n/a'
  return `${Math.min(...xs).toFixed(3)}–${Math.max(...xs).toFixed(3)}`
}

const fmtDelta = (va: unknown, vb: unknown): string => {
  if (typeof va !== 'number' || typeof vb !== 'number') return 'n/a'
  const d = (vb - va).toFixed(3)
  return va <= vb ? `+${d === '-0.000' ? '0.000' : d}` : d
}

export function compareReports(a: Report, b: Report): string {
  const rowsOf = (r: Report) => r.per_case as Array<Record<string, any>>
  guardPair(
    {
      commit: a.provenance.fixture.commit,
      passes: a.provenance.passes,
      caseIds: rowsOf(a).map((c) => c.id),
    },
    {
      commit: b.provenance.fixture.commit,
      passes: b.provenance.passes,
      caseIds: rowsOf(b).map((c) => c.id),
    },
    'compare reports',
  )
  const lines: string[] = [
    `compare — fixture ${a.provenance.fixture.name}@${a.provenance.fixture.commit}, ` +
      `${a.provenance.passes} pass(es), ${rowsOf(a).length} case(s)`,
  ]
  const mapB = new Map(rowsOf(b).map((c) => [c.id as string, c]))
  for (const ca of rowsOf(a)) {
    const cb = mapB.get(ca.id)
    lines.push(`${ca.id} (${ca.review_status ?? 'draft'}):`)
    for (const m of METRICS) {
      if (!(m.field in ca)) continue
      lines.push(
        `  ${m.field.padEnd(24)} A ${fmtV(ca[m.field])} ` +
          `[${spread(ca.per_pass ?? [], m.passField)}]  ` +
          `B ${fmtV(cb?.[m.field])} [${spread(cb?.per_pass ?? [], m.passField)}]  ` +
          `Δ ${fmtDelta(ca[m.field], cb?.[m.field])}`,
      )
    }
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// judgedAgreement
// ---------------------------------------------------------------------------

const FACT_TYPES = ['stated', 'partial', 'absent'] as const
const SENTENCE_TYPES = ['supported', 'unsupported'] as const

interface VerdictTally {
  agree: Record<string, number>
  either: Record<string, number>
  excluded: number
}

const newTally = (): VerdictTally => ({
  agree: {},
  either: {},
  excluded: 0,
})

const caseIdOf = (key: string): string => key.split('|')[0]

/**
 * Per-verdict-type agreement between two judged artifacts over the same
 * capture. For verdict type v, the denominator is the positions where both
 * judges produced a verdict and AT LEAST ONE said v (a disagreement between
 * stated and absent therefore shows up in both buckets) — a symmetric
 * measure, unlike conditioning on one judge's label. Keys present in only
 * one artifact, or unjudged (tombstone) in either, are excluded and counted.
 * unsupported_claims items are not verdict types and are ignored entirely.
 */
export function judgedAgreement(a: JudgedArtifact, b: JudgedArtifact): string {
  if (a.provenance.fixture.commit !== b.provenance.fixture.commit) {
    throw new Error(
      `refusing to compare: judged artifacts come from different fixture ` +
        `commits (${a.provenance.fixture.commit} vs ${b.provenance.fixture.commit})`,
    )
  }
  // Fixture case metadata (source_language / snippets) lives only in the
  // evalset — re-loaded from the recorded fixture path, like run-score.
  const evalset = loadEvalset(a.provenance.fixture.path)
  const langOfCase = new Map<string, 'zh' | 'en'>()
  for (const c of evalset.test_cases) {
    const lang = c.source_language
      ? c.source_language
      : langOf(
          c.retrieval_ground_truth?.expected_passages?.[0]?.text_snippet ?? '',
        )
    langOfCase.set(c.id, lang === 'zh' ? 'zh' : 'en')
  }

  const buckets = { zh: newTally(), en: newTally() }
  const bucketOf = (key: string) =>
    buckets[langOfCase.get(caseIdOf(key)) === 'zh' ? 'zh' : 'en']

  let totalAgree = 0
  let totalCompared = 0
  const keys = new Set([...Object.keys(a.items), ...Object.keys(b.items)])
  for (const key of keys) {
    const ia: JudgedItem | undefined = a.items[key]
    const ib: JudgedItem | undefined = b.items[key]
    if (ia?.kind === 'unsupported_claims' || ib?.kind === 'unsupported_claims')
      continue
    if (!ia || !ib || ia.unjudged || ib.unjudged || ia.kind !== ib.kind) {
      bucketOf(key).excluded++
      continue
    }
    const t = bucketOf(key)
    const compare = (va: string, vb: string) => {
      totalCompared++
      if (va === vb) {
        totalAgree++
        t.agree[va] = (t.agree[va] ?? 0) + 1
        t.either[va] = (t.either[va] ?? 0) + 1
      } else {
        // A disagreement shows up in BOTH buckets (at least one said v).
        for (const v of [va, vb]) t.either[v] = (t.either[v] ?? 0) + 1
      }
    }
    if (ia.kind === 'fact_recall' && ib.kind === 'fact_recall') {
      const vb = new Map(ib.verdicts.map((v) => [v.fact_index, v.verdict]))
      for (const v of ia.verdicts) {
        const other = vb.get(v.fact_index)
        if (other === undefined) {
          t.excluded++
          continue
        }
        compare(v.verdict, other)
      }
    } else if (
      ia.kind === 'sentence_support' &&
      ib.kind === 'sentence_support'
    ) {
      compare(ia.verdict, ib.verdict)
    }
  }

  const pct = (t: VerdictTally, v: string) =>
    t.either[v] > 0
      ? `${t.agree[v] ?? 0}/${t.either[v]} (${((100 * (t.agree[v] ?? 0)) / t.either[v]).toFixed(1)}%)`
      : `${t.agree[v] ?? 0}/0 (n/a)`

  const lines = [
    `judge agreement — fixture ${a.provenance.fixture.name}@${a.provenance.fixture.commit}`,
  ]
  for (const [label, t] of [
    ['zh-source cases', buckets.zh],
    ['english-source cases', buckets.en],
  ] as Array<[string, VerdictTally]>) {
    lines.push(`${label}:`)
    lines.push(
      `  fact verdicts: ${FACT_TYPES.map((v) => `${v} ${pct(t, v)}`).join(', ')}`,
    )
    lines.push(
      `  sentence verdicts: ${SENTENCE_TYPES.map((v) => `${v} ${pct(t, v)}`).join(', ')}`,
    )
    lines.push(`  excluded items: ${t.excluded}`)
  }
  lines.push(
    `overall agreement: ${totalAgree}/${totalCompared} ` +
      `(${totalCompared > 0 ? ((100 * totalAgree) / totalCompared).toFixed(1) : '0.0'}%)`,
  )
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// runPairwise
// ---------------------------------------------------------------------------

export interface PairwiseVerdict {
  case: string
  pass: number
  /** verdict of the run where A was presented first ('a' = A preferred) */
  orderAB?: 'a' | 'b' | 'tie'
  /** verdict of the run where B was presented first */
  orderBA?: 'a' | 'b' | 'tie'
  reason?: string
  /** tombstone from an aborted/failed run — retried on resume */
  unjudged?: { reason: string; raw: string }
}

/** key: `${caseId}|${pass}` */
export interface PairwiseArtifact {
  schema: 'answer-eval/pairwise@1'
  labelA: string
  labelB: string
  judge_model: string
  prompt_hash: string
  items: Record<string, PairwiseVerdict>
}

export interface PairwiseArgs {
  captureA: CaptureArtifact
  captureB: CaptureArtifact
  labelA: string
  labelB: string
  /** resumable output — `pairwise-<labelA>-vs-<labelB>.json` */
  pairwisePath: string
  judge: typeof judgeCall
  judgeModel: string
  /** API key follows resolveProvider's rule (same as run-judge) */
  judgeBaseUrl?: string
  /** default Math.random; injectable so tests run deterministically */
  rng?: () => number
}

/** Atomic-ish write: temp file + rename, so a reader never sees a torn file. */
function writePairwiseArtifact(
  pairwisePath: string,
  artifact: PairwiseArtifact,
): void {
  const tmp = `${pairwisePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(artifact, null, 2) + '\n')
  fs.renameSync(tmp, pairwisePath)
}

/** passages_sent entries whose chunk_id appears in BOTH captures' pass. */
function sharedPassages(
  a: PassageSent[],
  b: PassageSent[],
): Array<{ text: string }> {
  const theirs = new Set(b.map((p) => p.chunk_id))
  return a.filter((p) => theirs.has(p.chunk_id)).map((p) => ({ text: p.text }))
}

/** Map the judge's "one"/"two" onto 'a'/'b' relative to which run it was. */
const toVerdict = (
  preferred: 'one' | 'two' | 'tie',
  aWasOne: boolean,
): 'a' | 'b' | 'tie' =>
  preferred === 'tie' ? 'tie' : (preferred === 'one') === aWasOne ? 'a' : 'b'

/**
 * One (case, pass) pair: two judge runs with the presentation order
 * swapped. The first run's order comes from the rng; either order failing
 * leaves a tombstone so the whole pair is retried on resume.
 */
async function judgePair(p: {
  caseId: string
  pass: number
  question: string
  passages: Array<{ text: string }>
  answerA: string
  answerB: string
  judge: typeof judgeCall
  judgeModel: string
  baseUrl: string
  apiKey: string | undefined
  rng: () => number
}): Promise<PairwiseVerdict> {
  const aFirst = p.rng() < 0.5
  let orderAB: 'a' | 'b' | 'tie' | undefined
  let orderBA: 'a' | 'b' | 'tie' | undefined
  let reason: string | undefined
  let unjudged: { reason: string; raw: string } | undefined
  for (const aWasOne of [aFirst, !aFirst]) {
    const r = await p.judge({
      system: PAIRWISE_SYSTEM,
      user: pairwiseUser(
        p.question,
        p.passages,
        aWasOne ? p.answerA : p.answerB,
        aWasOne ? p.answerB : p.answerA,
      ),
      validate: validatePairwise,
      judgeModel: p.judgeModel,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
    })
    if (!r.ok) {
      unjudged = r.unjudged
      break
    }
    const verdict = toVerdict(r.verdict.preferred, aWasOne)
    if (aWasOne) {
      orderAB = verdict
      reason = r.verdict.reason
    } else {
      orderBA = verdict
    }
  }
  if (unjudged || !orderAB || !orderBA) {
    return {
      case: p.caseId,
      pass: p.pass,
      unjudged: unjudged ?? { reason: 'incomplete', raw: '' },
    }
  }
  return { case: p.caseId, pass: p.pass, orderAB, orderBA, reason }
}

export async function runPairwise(
  args: PairwiseArgs,
): Promise<PairwiseArtifact> {
  const {
    captureA,
    captureB,
    labelA,
    labelB,
    pairwisePath,
    judge,
    judgeModel,
  } = args
  guardPair(
    {
      commit: captureA.provenance.fixture.commit,
      passes: captureA.provenance.passes,
      caseIds: captureA.cases.map((c) => c.case_id),
    },
    {
      commit: captureB.provenance.fixture.commit,
      passes: captureB.provenance.passes,
      caseIds: captureB.cases.map((c) => c.case_id),
    },
    'run pairwise',
  )
  const baseUrl = args.judgeBaseUrl ?? ''
  const apiKey = resolveProvider(judgeModel, {
    base_url: baseUrl || undefined,
  }).apiKey
  const rng = args.rng ?? Math.random

  // Resume: existing non-tombstone (case,pass) entries are skipped.
  const items: Record<string, PairwiseVerdict> = {}
  if (fs.existsSync(pairwisePath)) {
    const existing = JSON.parse(
      fs.readFileSync(pairwisePath, 'utf8'),
    ) as PairwiseArtifact
    Object.assign(items, existing.items)
  }
  const artifact: PairwiseArtifact = {
    schema: 'answer-eval/pairwise@1',
    labelA,
    labelB,
    judge_model: judgeModel,
    prompt_hash: PROMPT_HASHES.pairwise,
    items,
  }

  for (const cA of captureA.cases) {
    const cB = captureB.cases.find((c) => c.case_id === cA.case_id)
    if (!cB) throw new Error(`case ${cA.case_id} missing in capture B`)
    for (const pA of cA.passes) {
      const key = `${cA.case_id}|${pA.pass}`
      if (items[key] && !items[key].unjudged) continue
      const pB = cB.passes.find((p) => p.pass === pA.pass)
      if (!pB) {
        throw new Error(
          `pass ${pA.pass} missing for case ${cA.case_id} in capture B`,
        )
      }
      const result = await judgePair({
        caseId: cA.case_id,
        pass: pA.pass,
        question: cA.fixture_case.question,
        passages: sharedPassages(
          pA.answer.passages_sent,
          pB.answer.passages_sent,
        ),
        answerA: pA.answer.sentences.join(' '),
        answerB: pB.answer.sentences.join(' '),
        judge,
        judgeModel,
        baseUrl,
        apiKey,
        rng,
      })
      items[key] = result
      writePairwiseArtifact(pairwisePath, artifact)
      console.log(
        `${key} … ${result.unjudged ? `unjudged (${result.unjudged.reason})` : `${result.orderAB}/${result.orderBA}`}`,
      )
    }
  }
  return artifact
}

/** Win rate + position-bias counts over a (complete) pairwise artifact. */
export function pairwiseSummary(artifact: PairwiseArtifact): string {
  const all = Object.values(artifact.items)
  const judged = all.filter((e) => !e.unjudged)
  const count = (f: (e: PairwiseVerdict) => boolean) => judged.filter(f).length
  const winsA = count((e) => e.orderAB === 'a' && e.orderBA === 'a')
  const winsB = count((e) => e.orderAB === 'b' && e.orderBA === 'b')
  const ties = count((e) => e.orderAB === 'tie' && e.orderBA === 'tie')
  const bias = count(
    (e) =>
      (e.orderAB === 'a' && e.orderBA === 'b') ||
      (e.orderAB === 'b' && e.orderBA === 'a'),
  )
  const splitTie = judged.length - winsA - winsB - ties - bias
  const pct = (n: number) =>
    judged.length > 0 ? `${((100 * n) / judged.length).toFixed(1)}%` : 'n/a'
  return (
    `pairwise ${artifact.labelA} vs ${artifact.labelB} — ${judged.length} judged ` +
    `(case,pass) pair(s), ${all.length - judged.length} unjudged\n` +
    `  ${artifact.labelA} wins both orders: ${winsA} (${pct(winsA)})\n` +
    `  ${artifact.labelB} wins both orders: ${winsB} (${pct(winsB)})\n` +
    `  tie in both orders: ${ties}\n` +
    `  position bias (preference flips with order): ${bias}\n` +
    `  split with tie (one order ties): ${splitTie}`
  )
}
