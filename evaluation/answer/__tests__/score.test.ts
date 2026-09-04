/** @jest-environment node */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { score, writeReportArtifact } from '../score'
import {
  CaptureArtifact,
  Evalset,
  JudgedArtifact,
  JudgedItem,
  PassCapture,
  Provenance,
  RetrievedChunk,
} from '../types'

/**
 * ONE hand-written fixture + capture + judged set with KNOWN scores. The
 * cases are arranged so every brief-enumerated number is asserted exactly:
 *
 * - q1 (expert_approved, headline): twin-passage evidence coverage 1.0 with
 *   a full-width-punctuation variant; twin collapse in doc MAP (A′ at rank 1
 *   credits A); chunk-id hit rate 0.5; fact recall strict 0.5 / lenient 1.0;
 *   citation precision 1/2; unsupported rate 1/3.
 * - q2 (draft): markdown-emphasized snippet still counts; a whitespace-only
 *   supporting snippet is skipped + counted (facts_no_snippet), never scored
 *   covered; corpus gap (doc_missing) excluded from the attainable
 *   denominator; concentration 5 chunks / 2 docs / top 3/5; pass 1 is a
 *   retrieval error (excluded, counted); its fact_recall item is an unjudged
 *   tombstone (excluded from means, counted).
 * - q3 (negative, draft): abstained via the strict signal
 *   (debug.warnings.isLowCoverage), not the capture's low_coverage field.
 * - q4 (negative, draft): warning string 'low_coverage' with a false strict
 *   signal is NOT an abstention (binding ruling).
 * - q5 (rejected): excluded from means, counted in the header.
 */

const evalset: Evalset = {
  name: 'score-test',
  version: '1',
  twins: [['doc_a', 'doc_a2']],
  test_cases: [
    {
      id: 'q1',
      question: 'What about trucks?',
      review_status: 'expert_approved',
      retrieval_ground_truth: {
        expected_external_ids: ['doc_a', 'doc_b'],
        expected_passages: [
          {
            doc_id: 'doc_a',
            chunk_id: 'doc_a_chunk_1',
            text_snippet: 'trucks move freight',
            supports_key_fact: 'fact one',
          },
          {
            doc_id: 'doc_b',
            chunk_id: 'doc_b_chunk_1',
            text_snippet: 'warming, accelerating',
            supports_key_fact: 'fact two',
          },
        ],
      },
      synthesis_ground_truth: { key_facts: ['fact one', 'fact two'] },
    },
    {
      id: 'q2',
      question: 'Peak demand?',
      retrieval_ground_truth: {
        expected_external_ids: ['doc_x', 'doc_missing'],
        expected_passages: [
          {
            doc_id: 'doc_x',
            chunk_id: 'doc_x_chunk_1',
            text_snippet: '**peak demand**',
            supports_key_fact: 'peak demand',
          },
          {
            doc_id: 'doc_x',
            chunk_id: 'doc_x_chunk_3',
            text_snippet: '   ',
            supports_key_fact: 'secret fact',
          },
        ],
      },
      synthesis_ground_truth: { key_facts: ['peak demand', 'secret fact'] },
    },
    { id: 'q3', question: 'Tell me about unicorns?' },
    { id: 'q4', question: 'Tell me about dragons?' },
    {
      id: 'q5',
      question: 'Rejected case?',
      review_status: 'rejected',
      retrieval_ground_truth: { expected_external_ids: ['doc_z'] },
      synthesis_ground_truth: { key_facts: ['z fact'] },
    },
  ],
}

const provenance: Provenance = {
  fixture: {
    path: '/tmp/score-test.json',
    name: 'score-test',
    commit: 'fixturesha0000',
  },
  target: { mode: 'gateway', urls: ['http://target'], config: null },
  knobs: { retrieval: {}, synthesis: {} },
  synthesis: {
    model: 'synth-model',
    base_url: 'http://synth/v1',
    prompt_hashes: { v1: 'h1', v2: 'h2' },
  },
  passes: 2,
  harness_sha: 'harnesssha0000',
  timestamp: '2026-09-05T12:00:00.000Z',
  node_version: 'v22.0.0',
}

const chunk = (
  rank: number,
  doc_id: string,
  chunk_id: string,
  text: string,
): RetrievedChunk => ({ rank, doc_id, chunk_id, text })

/** q1: [A′(twin of A), C, B] — A credited at rank 1 after twin collapse. */
const q1Pass = (pass: number): PassCapture => ({
  pass,
  retrieval: {
    chunks: [
      chunk(
        1,
        'doc_a2',
        'doc_a2_chunk_9',
        'Trucks move freight across borders.',
      ),
      chunk(2, 'doc_c', 'doc_c_chunk_1', 'Totally unrelated content.'),
      chunk(
        3,
        'doc_b',
        'doc_b_chunk_1',
        'Warming，accelerating faster than expected.',
      ),
    ],
    likely_off_topic: false,
    service_ms: 7,
    cost_usd: 0.01,
    wall_ms: 10,
  },
  answer: {
    knobs: {},
    passages_sent: [
      {
        id: 1,
        doc_id: 'doc_a2',
        chunk_id: 'doc_a2_chunk_9',
        page: 1,
        text: 'Trucks move freight across borders.',
      },
      {
        id: 2,
        doc_id: 'doc_b',
        chunk_id: 'doc_b_chunk_1',
        page: 1,
        text: 'Warming，accelerating faster than expected.',
      },
    ],
    sentences: [
      'Trucks move freight.',
      'Cities are doomed.',
      'A closing thought.',
    ],
    cites: [[1], [2], []],
    raw_model_json: JSON.stringify({
      parsing: { parsedSuccessfully: true },
      warnings: { isLowCoverage: false },
    }),
    low_coverage: false,
    invalid_cites: 0,
    wall_ms: 20,
  },
})

/** q2 pass 0: 5 chunks from 2 docs, top doc 3/5. */
const q2Pass = (pass: number): PassCapture => ({
  pass,
  retrieval: {
    chunks: [
      chunk(1, 'doc_x', 'doc_x_chunk_2', 'Peak demand hit a record.'),
      chunk(2, 'doc_y', 'doc_y_chunk_1', 'Other stuff one.'),
      chunk(3, 'doc_x', 'doc_x_chunk_5', 'Peak demand kept climbing.'),
      chunk(4, 'doc_y', 'doc_y_chunk_4', 'Other stuff two.'),
      chunk(5, 'doc_x', 'doc_x_chunk_9', 'Peak demand again.'),
    ],
    likely_off_topic: false,
    service_ms: 5,
    cost_usd: null,
    wall_ms: 8,
  },
  answer: {
    knobs: {},
    passages_sent: [
      {
        id: 1,
        doc_id: 'doc_x',
        chunk_id: 'doc_x_chunk_2',
        page: 1,
        text: 'Peak demand hit a record.',
      },
    ],
    sentences: ['Peak demand hit a record.'],
    cites: [[1]],
    raw_model_json: JSON.stringify({
      parsing: { parsedSuccessfully: true },
      warnings: { isLowCoverage: false },
    }),
    low_coverage: false,
    invalid_cites: 0,
    wall_ms: 9,
  },
})

/** q2 pass 1: retrieval failed — the pass is excluded from every mean. */
const q2ErrorPass = (pass: number): PassCapture => ({
  pass,
  retrieval: {
    chunks: [],
    likely_off_topic: false,
    service_ms: null,
    cost_usd: null,
    wall_ms: 3,
    error: 'gateway exploded',
  },
  answer: {
    knobs: {},
    passages_sent: [],
    sentences: [],
    cites: [],
    raw_model_json: '',
    low_coverage: false,
    invalid_cites: 0,
    wall_ms: 0,
    error: 'skipped: retrieval failed (gateway exploded)',
  },
})

/** q3: abstained via debug.warnings.isLowCoverage (the strict signal). */
const q3Pass = (pass: number): PassCapture => ({
  pass,
  retrieval: {
    chunks: [],
    likely_off_topic: false,
    service_ms: 2,
    cost_usd: null,
    wall_ms: 2,
  },
  answer: {
    knobs: {},
    passages_sent: [],
    sentences: [],
    cites: [],
    raw_model_json: JSON.stringify({
      parsing: { parsedSuccessfully: true },
      warnings: { isLowCoverage: true },
    }),
    low_coverage: false,
    invalid_cites: 0,
    wall_ms: 4,
  },
})

/**
 * q4 pass 0: the route's few-sources branch sets warning 'low_coverage' (and
 * the capture mirrors it into answer.low_coverage) WITHOUT the strict signal —
 * ruling: that alone is NOT an abstention.
 * q4 pass 1: the nano filter's all_weak early return — a genuine abstention
 * whose debug block carries `nanoFilter: 'all_weak'` and NO `warnings` key.
 */
const q4Pass = (pass: number): PassCapture => ({
  pass,
  retrieval: {
    chunks: [chunk(1, 'doc_c', 'doc_c_chunk_1', 'Some chunk.')],
    likely_off_topic: false,
    service_ms: 2,
    cost_usd: null,
    wall_ms: 2,
  },
  answer: {
    knobs: {},
    passages_sent: [
      {
        id: 1,
        doc_id: 'doc_c',
        chunk_id: 'doc_c_chunk_1',
        page: 1,
        text: 'Some chunk.',
      },
    ],
    sentences: ['A hedged sentence.'],
    cites: [],
    raw_model_json: JSON.stringify(
      pass === 1
        ? { nanoFilter: 'all_weak', coverage: 'poor' }
        : {
            parsing: { parsedSuccessfully: true },
            warnings: { isLowCoverage: false },
          },
    ),
    warning: 'low_coverage',
    low_coverage: true,
    invalid_cites: 0,
    wall_ms: 4,
  },
})

const q5Pass = (pass: number): PassCapture => ({
  pass,
  retrieval: {
    chunks: [chunk(1, 'doc_z', 'doc_z_chunk_1', 'Rejected doc text.')],
    likely_off_topic: false,
    service_ms: 1,
    cost_usd: null,
    wall_ms: 1,
  },
  answer: {
    knobs: {},
    passages_sent: [
      {
        id: 1,
        doc_id: 'doc_z',
        chunk_id: 'doc_z_chunk_1',
        page: 1,
        text: 'Rejected doc text.',
      },
    ],
    sentences: ['Rejected answer.'],
    cites: [[1]],
    raw_model_json: JSON.stringify({
      parsing: { parsedSuccessfully: true },
      warnings: { isLowCoverage: false },
    }),
    low_coverage: false,
    invalid_cites: 0,
    wall_ms: 3,
  },
})

const capture: CaptureArtifact = {
  schema: 'answer-eval/capture@1',
  provenance,
  // doc_missing is a corpus gap: excluded from q2's attainable denominators.
  preflight: {
    corpus_ok: false,
    missing_docs: ['doc_missing'],
    snippet_failures: [],
    twins_ok: true,
    synthesis_probe_ok: true,
    judge_probe_ok: true,
    approved: 1,
    draft: 3,
    rejected: 1,
    estimated_calls: { retrieval: 10, synthesis: 10, judge: 0 },
  },
  cases: [
    {
      case_id: 'q1',
      fixture_case: evalset.test_cases[0],
      passes: [q1Pass(0), q1Pass(1)],
    },
    {
      case_id: 'q2',
      fixture_case: evalset.test_cases[1],
      passes: [q2Pass(0), q2ErrorPass(1)],
    },
    {
      case_id: 'q3',
      fixture_case: evalset.test_cases[2],
      passes: [q3Pass(0), q3Pass(1)],
    },
    {
      case_id: 'q4',
      fixture_case: evalset.test_cases[3],
      passes: [q4Pass(0), q4Pass(1)],
    },
    {
      case_id: 'q5',
      fixture_case: evalset.test_cases[4],
      passes: [q5Pass(0), q5Pass(1)],
    },
  ],
}

const judgeCommon = { prompt_hash: 'ph0000', judge_model: 'judge-model' }

const factItem = (
  verdicts: Array<{
    fact_index: number
    verdict: 'stated' | 'partial' | 'absent'
    evidence: string
  }>,
): JudgedItem => ({ kind: 'fact_recall', verdicts, ...judgeCommon })

const ssItem = (
  i: number,
  verdict: 'supported' | 'unsupported',
): JudgedItem => ({
  kind: 'sentence_support',
  sentence_index: i,
  verdict,
  span: 'span',
  ...judgeCommon,
})

const ucItem = (indices: number[]): JudgedItem => ({
  kind: 'unsupported_claims',
  unsupported_sentence_indices: indices,
  reasons: indices.map(() => 'why'),
  ...judgeCommon,
})

const q1Items = (pass: number): Record<string, JudgedItem> => ({
  [`q1|${pass}|fact_recall:`]: factItem([
    { fact_index: 0, verdict: 'stated', evidence: 'trucks' },
    { fact_index: 1, verdict: 'partial', evidence: 'warming' },
  ]),
  [`q1|${pass}|sentence_support:0`]: ssItem(0, 'supported'),
  [`q1|${pass}|sentence_support:1`]: ssItem(1, 'unsupported'),
  [`q1|${pass}|unsupported_claims:`]: ucItem([2]),
})

const q2Items: Record<string, JudgedItem> = {
  // Tombstone: excluded from the fact-recall means, counted as unjudged.
  'q2|0|fact_recall:': {
    kind: 'fact_recall',
    ...judgeCommon,
    unjudged: { reason: 'judge 401', raw: 'auth error' },
  } as unknown as JudgedItem,
  'q2|0|sentence_support:0': ssItem(0, 'supported'),
  'q2|0|unsupported_claims:': ucItem([]),
}

const judged: JudgedArtifact = {
  schema: 'answer-eval/judged@1',
  usage: { prompt_tokens: 4321, completion_tokens: 876, calls: 9 },
  provenance: {
    ...provenance,
    judge: {
      model: 'judge-model',
      base_url: 'http://judge/v1',
      prompt_hashes: {
        fact_recall: 'h1',
        sentence_support: 'h2',
        unsupported_claims: 'h3',
      },
    },
  },
  items: { ...q1Items(0), ...q1Items(1), ...q2Items },
}

const report = score(evalset, capture, judged)

describe('score — report shape and header', () => {
  it('uses the report schema and copies provenance verbatim from the judged artifact', () => {
    expect(report.schema).toBe('answer-eval/report@1')
    expect(report.provenance).toEqual(judged.provenance)
    expect(report.provenance.judge).toBeDefined()
  })

  it('header: uncalibrated judge, models, fixture, target, knobs, passes, case counts, unjudged, excluded passes, cost', () => {
    const h = report.header as Record<string, any>
    expect(h.judge).toBe('uncalibrated')
    expect(h.judge_model).toBe('judge-model')
    expect(h.fixture).toEqual({
      path: '/tmp/score-test.json',
      name: 'score-test',
      commit: 'fixturesha0000',
    })
    expect(h.target).toBe(provenance.target)
    expect(h.synthesis_model).toBe('synth-model')
    expect(h.knobs).toBe(provenance.knobs)
    expect(h.passes).toBe(2)
    expect(h.cases).toEqual({ total: 5, approved: 1, draft: 3, rejected: 1 })
    expect(h.unjudged).toEqual({
      total: 1,
      fact_recall: 1,
      sentence_support: 0,
      unsupported_claims: 0,
    })
    expect(h.excluded_passes).toEqual({ retrieval_error: 1, answer_error: 0 })
    expect(h.cost).toEqual({
      retrieval_usd_total: 0.02,
      retrieval_calls_reported: 2,
      // Judge spend surfaced as token counts + call count, not dollars.
      judge: { prompt_tokens: 4321, completion_tokens: 876, calls: 9 },
    })
  })

  it('header: cost.judge is null for a judged artifact without usage (backward compat)', () => {
    const legacy = score(evalset, capture, {
      ...judged,
      usage: undefined,
    })
    expect((legacy.header as Record<string, any>).cost.judge).toBeNull()
  })
})

describe('score — headline block (expert_approved only)', () => {
  const h = report.headline as Record<string, any>

  it('evidence coverage 1.0: twin passage + full-width-punctuation variant', () => {
    expect(h.cases).toBe(1)
    expect(h.retrieval.evidence_coverage).toEqual({ mean: 1, cases: 1 })
    expect(h.retrieval.facts_no_snippet).toBe(0)
    expect(h.retrieval.facts_no_passage).toBe(0)
  })

  it('twin collapse in doc MAP: A′ at rank 1 credits A → 5/6; attainable recall 1.0', () => {
    expect(h.retrieval.doc_map.cases).toBe(1)
    expect(h.retrieval.doc_map.mean).toBeCloseTo(5 / 6, 12)
    expect(h.retrieval.attainable_recall).toEqual({ mean: 1, cases: 1 })
  })

  it('concentration: distinct docs and top-doc share', () => {
    expect(h.retrieval.distinct_docs).toEqual({ mean: 3, cases: 1 })
    expect(h.retrieval.top_doc_share).toEqual({ mean: 1 / 3, cases: 1 })
  })

  it('chunk-id hit rate (diagnostic): exact matches only → 0.5', () => {
    expect(h.retrieval.chunk_id_hit_rate).toEqual({ mean: 0.5, cases: 1 })
  })

  it('fact recall strict 0.5 / lenient 1.0', () => {
    expect(h.synthesis.fact_recall_strict).toEqual({ mean: 0.5, cases: 1 })
    expect(h.synthesis.fact_recall_lenient).toEqual({ mean: 1, cases: 1 })
  })

  it('citation precision 1/2 over judged sentences with ≥1 cite', () => {
    expect(h.synthesis.citation_precision).toEqual({ mean: 0.5, cases: 1 })
  })

  it('unsupported claims: count, the judged-pass count it covers, and rate', () => {
    expect(h.synthesis.unsupported_claims_count).toBe(2) // 1 per pass × 2 passes
    expect(h.synthesis.unsupported_claims_judged_passes).toBe(2)
    expect(h.synthesis.unsupported_claims_rate).toEqual({
      mean: 1 / 3,
      cases: 1,
    })
  })

  it('an unjudged unsupported_claims item contributes nothing to the count AND drops out of its judged-pass denominator', () => {
    const items = { ...judged.items }
    delete items['q1|1|unsupported_claims:']
    const r = score(evalset, capture, { ...judged, items })
    const hh = r.headline as Record<string, any>
    expect(hh.synthesis.unsupported_claims_count).toBe(1)
    expect(hh.synthesis.unsupported_claims_judged_passes).toBe(1)
    expect((r.header as Record<string, any>).unjudged.unsupported_claims).toBe(
      1,
    )
    const q1 = (r.per_case as Array<Record<string, any>>)[0]
    expect(q1.unsupported_claims_count).toBe(1)
    expect(q1.unsupported_claims_judged_passes).toBe(1)
  })

  it('parsed_clean is false when the route repaired a truncated reply (warnings.isPartial)', () => {
    const partial = structuredClone(capture)
    partial.cases[0].passes[1].answer.raw_model_json = JSON.stringify({
      parsing: { parsedSuccessfully: true },
      warnings: { isLowCoverage: false, isPartial: true },
    })
    const r = score(evalset, partial, judged)
    expect((r.headline as Record<string, any>).compliance.parsed_clean).toBe(1)
  })

  it('computed contract compliance and sentence-count distribution', () => {
    expect(h.compliance).toEqual({
      passes: 2,
      cites_valid: 2,
      parsed_clean: 2,
      all_english: 2,
      sentence_counts: { 3: 2 },
    })
  })

  it('no negative cases in the headline → empty abstention block', () => {
    expect(h.abstention).toEqual({
      negative_cases: 0,
      passes: 0,
      abstained: 0,
      rate: 0,
    })
  })
})

describe('score — draft block (draft cases, never mixed with headline)', () => {
  const d = report.draft_block as Record<string, any>

  it('counts the draft cases (q2, q3, q4) and excludes the rejected one', () => {
    expect(d.cases).toBe(3)
  })

  it('markdown-emphasized snippet still counts; whitespace-only snippet skipped + counted, never scored covered', () => {
    expect(d.retrieval.evidence_coverage).toEqual({ mean: 1, cases: 1 })
    expect(d.retrieval.facts_no_snippet).toBe(1)
  })

  it('corpus gap (doc_missing) excluded from the attainable denominators', () => {
    expect(d.retrieval.doc_map).toEqual({ mean: 1, cases: 1 })
    expect(d.retrieval.attainable_recall).toEqual({ mean: 1, cases: 1 })
  })

  it('concentration: 5 chunks from 2 docs, top doc 3/5', () => {
    expect(d.retrieval.distinct_docs).toEqual({ mean: 2, cases: 1 })
    expect(d.retrieval.top_doc_share).toEqual({ mean: 0.6, cases: 1 })
  })

  it('chunk-id hit rate 0 (expected chunk never retrieved)', () => {
    expect(d.retrieval.chunk_id_hit_rate).toEqual({ mean: 0, cases: 1 })
  })

  it('unjudged fact item excluded from the means (null, zero cases) and counted in the header', () => {
    expect(d.synthesis.fact_recall_strict).toEqual({ mean: null, cases: 0 })
    expect(d.synthesis.fact_recall_lenient).toEqual({ mean: null, cases: 0 })
  })

  it('citation precision and unsupported claims from q2 only', () => {
    expect(d.synthesis.citation_precision).toEqual({ mean: 1, cases: 1 })
    expect(d.synthesis.unsupported_claims_count).toBe(0)
    expect(d.synthesis.unsupported_claims_rate).toEqual({ mean: 0, cases: 1 })
  })

  it('compliance covers the positive draft passes only', () => {
    expect(d.compliance).toEqual({
      passes: 1,
      cites_valid: 1,
      parsed_clean: 1,
      all_english: 1,
      sentence_counts: { 1: 1 },
    })
  })

  it('abstention (negative cases, reported apart): strict signal or nano all_weak', () => {
    expect(d.abstention).toEqual({
      negative_cases: 2,
      passes: 4,
      abstained: 3,
      rate: 0.75,
    })
  })
})

describe('score — per_case', () => {
  const cases = report.per_case as Array<Record<string, any>>

  it('carries every case in capture order with fixture fields passed through', () => {
    expect(cases.map((c) => c.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5'])
    expect(cases[0].question).toBe('What about trucks?')
    expect(cases[0].review_status).toBe('expert_approved')
    expect(cases[4].review_status).toBe('rejected')
  })

  it('q1: per_pass values and case-level means', () => {
    const q1 = cases[0]
    expect(q1.per_pass).toHaveLength(2)
    expect(q1.per_pass[0]).toMatchObject({
      pass: 0,
      evidence_coverage: 1,
      facts_no_snippet: 0,
      distinct_docs: 3,
      top_doc_share: 1 / 3,
      chunk_id_hit_rate: 0.5,
      fact_recall_strict: 0.5,
      fact_recall_lenient: 1,
      citation_precision: 0.5,
      unsupported_claims_count: 1,
      unsupported_claims_rate: 1 / 3,
      cites_valid: true,
      parsed_clean: true,
      all_english: true,
      sentence_count: 3,
    })
    expect(q1.per_pass[0].doc_map).toBeCloseTo(5 / 6, 12)
    expect(q1.per_pass[0].attainable_recall).toBe(1)
    expect(q1.evidence_coverage).toBe(1)
    expect(q1.doc_map).toBeCloseTo(5 / 6, 12)
    expect(q1.fact_recall_strict).toBe(0.5)
  })

  it('q2: retrieval-error pass excluded; unjudged flag on the tombstoned fact item; case means over valid passes only', () => {
    const q2 = cases[1]
    expect(q2.per_pass).toHaveLength(2)
    expect(q2.per_pass[1]).toEqual({ pass: 1, excluded: 'retrieval_error' })
    expect(q2.per_pass[0].fact_recall_unjudged).toBe(true)
    expect(q2.per_pass[0].facts_no_snippet).toBe(1)
    expect(q2.evidence_coverage).toBe(1)
    expect(q2.doc_map).toBe(1)
    expect(q2.fact_recall_strict).toBeNull()
    expect(q2.citation_precision).toBe(1)
  })

  it('q3: abstained via the strict signal despite a false capture low_coverage field', () => {
    const q3 = cases[2]
    expect(q3.per_pass[0].abstained).toBe(true)
    expect(q3.abstention_rate).toBe(1)
  })

  it('q4: warning string alone is NOT an abstention; the nano all_weak return IS', () => {
    const q4 = cases[3]
    expect(q4.per_pass[0].abstained).toBe(false)
    expect(q4.per_pass[1].abstained).toBe(true)
    expect(q4.abstention_rate).toBe(0.5)
  })
})

describe('score — determinism (§6)', () => {
  it('identical inputs stringify identically', () => {
    const again = score(evalset, capture, judged)
    expect(JSON.stringify(again)).toBe(JSON.stringify(report))
  })

  it('two file writes are byte-equal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-report-'))
    const f1 = writeReportArtifact(dir, 'replay', report)
    const f2 = writeReportArtifact(
      dir,
      'replay',
      score(evalset, capture, judged),
    )
    expect(path.basename(f1)).toBe('report-replay.json')
    expect(fs.readFileSync(f1, 'utf8')).toBe(fs.readFileSync(f2, 'utf8'))
  })
})
