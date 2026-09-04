/**
 * Score stage (§2.2/§2.3): a PURE reduction of a capture artifact + judged
 * artifact into the report. No I/O, no clock, no randomness — the report
 * carries no timestamp of its own (provenance is copied verbatim from the
 * judged artifact), so identical inputs stringify byte-identically (§6).
 *
 * Exclusion rules (binding, carried from task reviews):
 * - retrieval/answer-error passes are excluded from every mean and counted
 *   in header.excluded_passes;
 * - unjudged items (missing or tombstone) are excluded from the means they
 *   would feed and counted in header.unjudged — never scored as zero;
 * - rejected cases are excluded from means (counted in header.cases);
 * - negative cases contribute ONLY to the abstention block — their answers
 *   have no ground truth to score against;
 * - evidence-coverage facts whose supporting passages ALL have empty
 *   snippets are skipped and counted (facts_no_snippet): an empty snippet
 *   is contained in every chunk, so scoring it covered would lie;
 * - abstention uses the STRICT signal (debug.warnings.isLowCoverage inside
 *   raw_model_json, the nano filter's all_weak early return, or the
 *   gateway's likely_off_topic) — the route's few-sources
 *   `warning: 'low_coverage'` string would over-count.
 * - unsupported_claims_count is a sum over JUDGED passes only, and is always
 *   reported next to that pass count (unsupported_claims_judged_passes) so
 *   an unjudged item can never read as "zero claims".
 */
import * as fs from 'fs'
import * as path from 'path'
import { averagePrecision } from '../lib/metrics'
import { judgeHumanAgreement, validateLabelsAgainstCapture } from './labels'
import { expectedIdsOf, isNegative, keyFactsOf, twinOf } from './fixture'
import { langOf, snippetContained } from './normalize'
import {
  CaptureArtifact,
  CaseCapture,
  Evalset,
  ExpectedPassage,
  HumanLabels,
  JudgedArtifact,
  JudgedItem,
  JudgeAgreement,
  PassCapture,
  Report,
  RetrievedChunk,
} from './types'

/** A mean plus the case count it was taken over (null = nothing to score). */
export interface MetricMean {
  mean: number | null
  cases: number
}

export interface BlockReport {
  cases: number
  retrieval: {
    evidence_coverage: MetricMean
    facts_no_snippet: number
    facts_no_passage: number
    doc_map: MetricMean
    attainable_recall: MetricMean
    distinct_docs: MetricMean
    top_doc_share: MetricMean
    chunk_id_hit_rate: MetricMean
  }
  synthesis: {
    fact_recall_strict: MetricMean
    fact_recall_lenient: MetricMean
    citation_precision: MetricMean
    unsupported_claims_count: number
    /** Passes the count was summed over (unjudged passes are absent). */
    unsupported_claims_judged_passes: number
    unsupported_claims_rate: MetricMean
  }
  compliance: {
    passes: number
    cites_valid: number
    parsed_clean: number
    all_english: number
    sentence_counts: Record<string, number>
  }
  abstention: {
    negative_cases: number
    passes: number
    abstained: number
    rate: number
  }
}

/**
 * Per-pass metrics. One shape, conditionally populated: excluded passes
 * carry only `excluded`, negative passes only `abstained`, positive passes
 * the full metric set. Field presence is a function of the input, so the
 * serialized form stays deterministic.
 */
interface PassMetrics {
  pass: number
  excluded?: 'retrieval_error' | 'answer_error'
  abstained?: boolean
  evidence_coverage?: number
  facts_no_snippet?: number
  facts_no_passage?: number
  doc_map?: number
  attainable_recall?: number
  distinct_docs?: number
  top_doc_share?: number
  chunk_id_hit_rate?: number
  fact_recall_strict?: number
  fact_recall_lenient?: number
  fact_recall_unjudged?: boolean
  citation_precision?: number
  unsupported_claims_count?: number
  unsupported_claims_rate?: number
  unsupported_claims_unjudged?: boolean
  sentence_support_unjudged?: boolean
  cites_valid?: boolean
  parsed_clean?: boolean
  all_english?: boolean
  sentence_count?: number
}

interface ScoredCase {
  case: CaseCapture
  negative: boolean
  passes: PassMetrics[]
}

/** The subset of the route's debug block the scorer reads out of
 * raw_model_json (the SERIALIZED DEBUG BLOCK, never raw model content). */
interface RouteDebug {
  parsing?: { parsedSuccessfully?: boolean }
  warnings?: { isLowCoverage?: boolean; isPartial?: boolean }
  /** 'all_weak' on the nano filter's early return — that path never sets
   * `warnings`, so it is an abstention signal in its own right. */
  nanoFilter?: string
}

function parseDebug(raw: string): RouteDebug | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as RouteDebug
  } catch {
    return undefined
  }
}

const meanOf = (xs: number[]): number | null =>
  xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null

const tally = (xs: number[]): Record<string, number> => {
  const t: Record<string, number> = {}
  for (const x of xs) t[x] = (t[x] ?? 0) + 1
  return t
}

const dedup = (xs: string[]): string[] => [...new Set(xs)]

/** A passage supports a fact when supports_key_fact matches the fact, or
 * either side's " | "-joined form contains the other (fixtures list
 * multi-fact or multi-phrasing links that way). */
function supportsFact(p: ExpectedPassage, fact: string): boolean {
  const s = p.supports_key_fact
  if (s === undefined) return false
  return (
    s === fact || s.split(' | ').includes(fact) || fact.split(' | ').includes(s)
  )
}

interface ScoreCtx {
  items: Record<string, JudgedItem>
  missing: Set<string>
  evalset: Evalset
  /** Twin-pair representative of a doc id (pair member 0); id itself when
   * untwinned. Doc-level metrics collapse through this before scoring. */
  repOf: (id: string) => string
}

function scorePass(c: CaseCapture, p: PassCapture, ctx: ScoreCtx): PassMetrics {
  if (p.retrieval.error) return { pass: p.pass, excluded: 'retrieval_error' }
  if (p.answer.error) return { pass: p.pass, excluded: 'answer_error' }

  const fc = c.fixture_case
  const a = p.answer
  const debug = parseDebug(a.raw_model_json)

  if (isNegative(fc)) {
    return {
      pass: p.pass,
      abstained:
        debug?.warnings?.isLowCoverage === true ||
        debug?.nanoFilter === 'all_weak' ||
        p.retrieval.likely_off_topic === true,
    }
  }

  // --- §2.2 retrieval ---
  const chunks: RetrievedChunk[] = p.retrieval.chunks
  const passages = fc.retrieval_ground_truth?.expected_passages ?? []

  // Evidence coverage (primary). A supporting passage matches chunks of its
  // own doc OR its twin (a fact expected on doc A is covered by a chunk of
  // twin A′); the snippet must be contained (normalized) in the chunk text.
  const facts = keyFactsOf(fc)
  let covered = 0
  let denom = 0
  let noSnippet = 0
  let noPassage = 0
  for (const fact of facts) {
    const sup = passages.filter((pg) => supportsFact(pg, fact))
    if (sup.length === 0) {
      noPassage++
      continue
    }
    const withSnippet = sup.filter((pg) => pg.text_snippet.trim() !== '')
    if (withSnippet.length === 0) {
      noSnippet++
      continue
    }
    denom++
    if (
      withSnippet.some((pg) => {
        const docs = new Set<string>([pg.doc_id])
        const twin = twinOf(ctx.evalset, pg.doc_id)
        if (twin) docs.add(twin)
        return chunks.some(
          (ch) =>
            docs.has(ch.doc_id) && snippetContained(pg.text_snippet, ch.text),
        )
      })
    ) {
      covered++
    }
  }

  // Doc MAP + attainable recall: collapse doc ids to twin-pair
  // representatives BEFORE ranking; docs the preflight found missing from
  // the corpus are unattainable and leave the denominators.
  const expectedReps = dedup(expectedIdsOf(fc).map(ctx.repOf))
  const attainable = expectedReps.filter((r) => {
    const twin = twinOf(ctx.evalset, r)
    return !ctx.missing.has(r) && (twin === undefined || !ctx.missing.has(twin))
  })
  const retrievedReps = chunks.map((ch) => ctx.repOf(ch.doc_id))
  const doc_map =
    attainable.length > 0
      ? averagePrecision(attainable, retrievedReps)
      : undefined
  const attainable_recall =
    attainable.length > 0
      ? attainable.filter((r) => retrievedReps.includes(r)).length /
        attainable.length
      : undefined

  // Concentration: distinct docs (twin-collapsed — a doc and its translation
  // are one source) and the top doc's share of the list.
  const repCounts = new Map<string, number>()
  for (const ch of chunks) {
    const r = ctx.repOf(ch.doc_id)
    repCounts.set(r, (repCounts.get(r) ?? 0) + 1)
  }
  const distinct_docs = repCounts.size
  const top_doc_share =
    chunks.length > 0 ? Math.max(...repCounts.values()) / chunks.length : 0

  // Chunk-id hit rate (diagnostic only): exact chunk_id matches.
  const expectedChunkIds = new Set(
    passages.map((pg) => pg.chunk_id).filter((id) => id !== ''),
  )
  const retrievedChunkIds = new Set(
    chunks.map((ch) => ch.chunk_id).filter((id): id is string => !!id),
  )
  const chunk_id_hit_rate =
    expectedChunkIds.size > 0
      ? [...expectedChunkIds].filter((id) => retrievedChunkIds.has(id)).length /
        expectedChunkIds.size
      : undefined

  // --- §2.3 synthesis ---
  const key = (kind: string, index?: number) =>
    `${c.case_id}|${p.pass}|${kind}:${index ?? ''}`

  const factItem = ctx.items[key('fact_recall')]
  let fact_recall_strict: number | undefined
  let fact_recall_lenient: number | undefined
  let fact_recall_unjudged = false
  if (facts.length > 0) {
    if (!factItem || factItem.unjudged || factItem.kind !== 'fact_recall') {
      fact_recall_unjudged = true
    } else {
      const stated = factItem.verdicts.filter(
        (v) => v.verdict === 'stated',
      ).length
      const partial = factItem.verdicts.filter(
        (v) => v.verdict === 'partial',
      ).length
      fact_recall_strict = stated / facts.length
      fact_recall_lenient = (stated + partial) / facts.length
    }
  }

  // Citation precision over judged sentences with ≥1 cite (zero-cite
  // sentences are the unsupported_claims lane's job, ruling 4).
  let supported = 0
  let unsupported = 0
  let sentence_support_unjudged = false
  a.sentences.forEach((_, i) => {
    if ((a.cites[i] ?? []).length === 0) return
    const it = ctx.items[key('sentence_support', i)]
    if (!it || it.unjudged || it.kind !== 'sentence_support') {
      sentence_support_unjudged = true
      return
    }
    if (it.verdict === 'supported') supported++
    else unsupported++
  })
  const citation_precision =
    supported + unsupported > 0
      ? supported / (supported + unsupported)
      : undefined

  const unsupItem = ctx.items[key('unsupported_claims')]
  let unsupported_claims_count: number | undefined
  let unsupported_claims_rate: number | undefined
  let unsupported_claims_unjudged = false
  if (
    !unsupItem ||
    unsupItem.unjudged ||
    unsupItem.kind !== 'unsupported_claims'
  ) {
    unsupported_claims_unjudged = true
  } else {
    unsupported_claims_count = unsupItem.unsupported_sentence_indices.length
    unsupported_claims_rate =
      a.sentences.length > 0 ? unsupported_claims_count / a.sentences.length : 0
  }

  // --- computed contract compliance ---
  const cites_valid = a.invalid_cites === 0
  // "Parsed without repair": the route's partial-extraction path (a
  // truncated reply salvaged by regex) is a repair even though
  // parsedSuccessfully reads true. Brace-extraction repair leaves no debug
  // trace today — a `parsing.repaired` flag is a route-side follow-up.
  const parsed_clean =
    debug?.parsing?.parsedSuccessfully === true &&
    debug?.warnings?.isPartial !== true &&
    !a.fallback_reason
  const all_english = a.sentences.every((s) => langOf(s) !== 'zh')

  return {
    pass: p.pass,
    evidence_coverage: denom > 0 ? covered / denom : undefined,
    facts_no_snippet: noSnippet,
    facts_no_passage: noPassage,
    doc_map,
    attainable_recall,
    distinct_docs,
    top_doc_share,
    chunk_id_hit_rate,
    fact_recall_strict,
    fact_recall_lenient,
    fact_recall_unjudged,
    citation_precision,
    unsupported_claims_count,
    unsupported_claims_rate,
    unsupported_claims_unjudged,
    sentence_support_unjudged,
    cites_valid,
    parsed_clean,
    all_english,
    sentence_count: a.sentences.length,
  }
}

function scoreCase(c: CaseCapture, ctx: ScoreCtx): ScoredCase {
  return {
    case: c,
    negative: isNegative(c.fixture_case),
    passes: c.passes.map((p) => scorePass(c, p, ctx)),
  }
}

/** Case-level values: each metric is the mean over the case's non-excluded
 * passes (null when the case has nothing to score for it). */
function caseMetrics(s: ScoredCase): Record<string, number | null> {
  const valid = s.passes.filter((p) => !p.excluded)
  const m = (field: keyof PassMetrics): number | null =>
    meanOf(
      valid.map((p) => p[field]).filter((v): v is number => v !== undefined),
    )
  if (s.negative) {
    const abstained = valid.filter((p) => p.abstained).length
    return {
      abstention_rate: valid.length > 0 ? abstained / valid.length : null,
    }
  }
  return {
    evidence_coverage: m('evidence_coverage'),
    doc_map: m('doc_map'),
    attainable_recall: m('attainable_recall'),
    distinct_docs: m('distinct_docs'),
    top_doc_share: m('top_doc_share'),
    chunk_id_hit_rate: m('chunk_id_hit_rate'),
    fact_recall_strict: m('fact_recall_strict'),
    fact_recall_lenient: m('fact_recall_lenient'),
    citation_precision: m('citation_precision'),
    unsupported_claims_count: valid.reduce(
      (t, p) => t + (p.unsupported_claims_count ?? 0),
      0,
    ),
    unsupported_claims_judged_passes: valid.filter(
      (p) => p.unsupported_claims_count !== undefined,
    ).length,
    unsupported_claims_rate: m('unsupported_claims_rate'),
  }
}

/** Block means are means over case values (macro: case first, then block),
 * never pooling passes across unequal cases. */
function blockFrom(scored: ScoredCase[]): BlockReport {
  const positives = scored.filter((s) => !s.negative)
  const negativeCases = scored.filter((s) => s.negative)
  const posPasses = positives.flatMap((s) =>
    s.passes.filter((p) => !p.excluded),
  )
  const negPasses = negativeCases.flatMap((s) =>
    s.passes.filter((p) => !p.excluded),
  )
  const cms = positives.map(caseMetrics)
  const mm = (field: string): MetricMean => {
    const xs = cms.map((cm) => cm[field]).filter((v): v is number => v !== null)
    return { mean: meanOf(xs), cases: xs.length }
  }
  const abstained = negPasses.filter((p) => p.abstained).length
  return {
    cases: scored.length,
    retrieval: {
      evidence_coverage: mm('evidence_coverage'),
      facts_no_snippet: posPasses.reduce(
        (t, p) => t + (p.facts_no_snippet ?? 0),
        0,
      ),
      facts_no_passage: posPasses.reduce(
        (t, p) => t + (p.facts_no_passage ?? 0),
        0,
      ),
      doc_map: mm('doc_map'),
      attainable_recall: mm('attainable_recall'),
      distinct_docs: mm('distinct_docs'),
      top_doc_share: mm('top_doc_share'),
      chunk_id_hit_rate: mm('chunk_id_hit_rate'),
    },
    synthesis: {
      fact_recall_strict: mm('fact_recall_strict'),
      fact_recall_lenient: mm('fact_recall_lenient'),
      citation_precision: mm('citation_precision'),
      unsupported_claims_count: posPasses.reduce(
        (t, p) => t + (p.unsupported_claims_count ?? 0),
        0,
      ),
      unsupported_claims_judged_passes: posPasses.filter(
        (p) => p.unsupported_claims_count !== undefined,
      ).length,
      unsupported_claims_rate: mm('unsupported_claims_rate'),
    },
    compliance: {
      passes: posPasses.length,
      cites_valid: posPasses.filter((p) => p.cites_valid).length,
      parsed_clean: posPasses.filter((p) => p.parsed_clean).length,
      all_english: posPasses.filter((p) => p.all_english).length,
      sentence_counts: tally(posPasses.map((p) => p.sentence_count ?? 0)),
    },
    abstention: {
      negative_cases: negativeCases.length,
      passes: negPasses.length,
      abstained,
      rate: negPasses.length > 0 ? abstained / negPasses.length : 0,
    },
  }
}

const statusOf = (s: ScoredCase): 'approved' | 'draft' | 'rejected' => {
  const st = s.case.fixture_case.review_status ?? 'draft'
  return st === 'expert_approved'
    ? 'approved'
    : st === 'rejected'
      ? 'rejected'
      : 'draft'
}

export function score(
  evalset: Evalset,
  capture: CaptureArtifact,
  judged: JudgedArtifact,
  labels?: HumanLabels[],
): Report {
  // §4.5 judge calibration: with labels, compute the judge-vs-human view ONCE
  // and merge it into the header. Labels are pure inputs (replay stays
  // byte-identical), and a label referencing a case/pass this capture does
  // not contain is a hard error — every rejection reason is listed, never
  // silently skipped.
  let agreement: JudgeAgreement | undefined
  if (labels) {
    const rejected = labels
      .map((l) => ({
        file: l.capture_file,
        v: validateLabelsAgainstCapture(l, capture),
      }))
      .filter((x) => !x.v.ok)
    if (rejected.length > 0) {
      const reasons = rejected
        .map(
          (x) => `${x.file}: ${(x.v as { ok: false; reason: string }).reason}`,
        )
        .join('; ')
      throw new Error(
        `labels invalid: ${rejected.length} of ${labels.length} label file(s) do not match this capture — ${reasons}`,
      )
    }
    agreement = judgeHumanAgreement(judged, labels, capture)
  }

  const ctx: ScoreCtx = {
    items: judged.items,
    missing: new Set(capture.preflight.missing_docs),
    repOf: (id: string) => {
      const pair = evalset.twins?.find(([a, b]) => a === id || b === id)
      return pair ? pair[0] : id
    },
    evalset,
  }
  const scoredAll = capture.cases.map((c) => scoreCase(c, ctx))
  const approved = scoredAll.filter((s) => statusOf(s) === 'approved')
  const draft = scoredAll.filter((s) => statusOf(s) === 'draft')
  const rejected = scoredAll.filter((s) => statusOf(s) === 'rejected')

  // Unjudged counting covers exactly the passes the block means would have
  // used: positive, non-excluded, non-rejected. Rejected/negative passes
  // never feed a mean, so their item gaps are not "unjudged" — they are
  // simply out of scope.
  const unjudged = {
    fact_recall: 0,
    sentence_support: 0,
    unsupported_claims: 0,
  }
  for (const s of [...approved, ...draft]) {
    if (s.negative) continue
    for (const p of s.passes) {
      if (p.excluded) continue
      if (p.fact_recall_unjudged) unjudged.fact_recall++
      if (p.sentence_support_unjudged) unjudged.sentence_support++
      if (p.unsupported_claims_unjudged) unjudged.unsupported_claims++
    }
  }

  const excluded = { retrieval_error: 0, answer_error: 0 }
  let costTotal = 0
  let costCalls = 0
  for (const s of scoredAll) {
    for (const p of s.passes) {
      if (p.excluded === 'retrieval_error') excluded.retrieval_error++
      else if (p.excluded === 'answer_error') excluded.answer_error++
    }
    for (const cp of s.case.passes) {
      const cost = cp.retrieval.cost_usd
      if (cost != null) {
        costTotal += cost
        costCalls++
      }
    }
  }

  const header = {
    judge: agreement
      ? {
          calibrated: true,
          labels: agreement.labels,
          reviewers: agreement.reviewers,
        }
      : 'uncalibrated', // §4.5 — no human labels exist yet
    ...(agreement ? { judge_agreement: agreement } : {}),
    judge_model: judged.provenance.judge?.model ?? '',
    fixture: capture.provenance.fixture,
    target: capture.provenance.target,
    synthesis_model: capture.provenance.synthesis.model,
    knobs: capture.provenance.knobs,
    passes: capture.provenance.passes,
    cases: {
      total: scoredAll.length,
      approved: approved.length,
      draft: draft.length,
      rejected: rejected.length,
    },
    unjudged: {
      total:
        unjudged.fact_recall +
        unjudged.sentence_support +
        unjudged.unsupported_claims,
      ...unjudged,
    },
    excluded_passes: excluded,
    cost: {
      retrieval_usd_total: costCalls > 0 ? costTotal : null,
      retrieval_calls_reported: costCalls,
      // Judge spend is token counts (never dollars — lunaroute pricing per
      // token is unmeasured), persisted by the judge stage.
      judge: judged.usage ?? null,
    },
  }

  return {
    schema: 'answer-eval/report@1',
    provenance: judged.provenance,
    header,
    headline: blockFrom(approved),
    draft_block: blockFrom(draft),
    per_case: scoredAll.map((s) => ({
      ...s.case.fixture_case,
      per_pass: s.passes,
      ...caseMetrics(s),
    })),
  }
}

/** Pretty-printed, stable key order. Returns the written file path. */
export function writeReportArtifact(
  artifactsDir: string,
  label: string,
  report: Report,
): string {
  fs.mkdirSync(artifactsDir, { recursive: true })
  const file = path.join(artifactsDir, `report-${label}.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  return file
}
