/** @jest-environment node */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { captureFingerprint } from '../judge'
import {
  judgeHumanAgreement,
  loadLabelsFrom,
  parseLabels,
  validateLabelsAgainstCapture,
} from '../labels'
import {
  CaptureArtifact,
  HumanLabels,
  JudgedArtifact,
  PreflightReport,
  Provenance,
} from '../types'

const PIN_HEX =
  '298a04f89fac6d6539a5a6fb6ce6be4e6158e9543d9ecb2d3cc951b0593451e8'

const makeProvenance = (): Provenance => ({
  fixture: { path: 'evalset.json', name: 'labels-test', commit: 'fixturesha' },
  target: { mode: 'gateway', urls: ['http://target'], config: null },
  knobs: { retrieval: {}, synthesis: {} },
  synthesis: { model: 'synth', base_url: 'http://synth', prompt_hashes: {} },
  passes: 1,
  harness_sha: 'harnesssha',
  timestamp: '2026-09-05T12:00:00Z',
  node_version: process.version,
})

const makePreflight = (): PreflightReport => ({
  corpus_ok: true,
  missing_docs: [],
  snippet_failures: [],
  twins_ok: true,
  synthesis_probe_ok: true,
  judge_probe_ok: true,
  approved: 2,
  draft: 0,
  rejected: 0,
  estimated_calls: { retrieval: 2, synthesis: 2, judge: 2 },
})

const passage = (id: number) => ({
  id,
  doc_id: 'd1',
  chunk_id: `c${id}`,
  page: 1,
  text: `passage ${id}`,
})

/** case-a: 3 sentences, s2 zero-cite; case-b: 2 sentences, t1 zero-cite. */
const makeCapture = (): CaptureArtifact => ({
  schema: 'answer-eval/capture@1',
  provenance: makeProvenance(),
  preflight: makePreflight(),
  cases: [
    {
      case_id: 'case-a',
      fixture_case: {
        id: 'case-a',
        question: 'question a',
        synthesis_ground_truth: { key_facts: ['f0', 'f1', 'f2'] },
      },
      passes: [
        {
          pass: 0,
          retrieval: {
            chunks: [],
            likely_off_topic: false,
            service_ms: null,
            cost_usd: null,
            wall_ms: 0,
          },
          answer: {
            knobs: {},
            passages_sent: [passage(1)],
            sentences: ['s0', 's1', 's2'],
            cites: [[1], [1], []],
            raw_model_json: '',
            low_coverage: false,
            invalid_cites: 0,
            wall_ms: 0,
          },
        },
      ],
    },
    {
      case_id: 'case-b',
      fixture_case: {
        id: 'case-b',
        question: 'question b',
        synthesis_ground_truth: { key_facts: ['g0'] },
      },
      passes: [
        {
          pass: 0,
          retrieval: {
            chunks: [],
            likely_off_topic: false,
            service_ms: null,
            cost_usd: null,
            wall_ms: 0,
          },
          answer: {
            knobs: {},
            passages_sent: [passage(1)],
            sentences: ['t0', 't1'],
            cites: [[1], []],
            raw_model_json: '',
            low_coverage: false,
            invalid_cites: 0,
            wall_ms: 0,
          },
        },
      ],
    },
  ],
})

/** case-a|0 judged: facts stated/stated/absent, sentences supported/supported,
 * zero-cite s2 listed in unsupported_claims. case-b has NO judged items. */
const makeJudged = (): JudgedArtifact => ({
  schema: 'answer-eval/judged@1',
  provenance: makeProvenance(),
  items: {
    'case-a|0|fact_recall:': {
      kind: 'fact_recall',
      prompt_hash: 'ph',
      judge_model: 'jm',
      verdicts: [
        { fact_index: 0, verdict: 'stated', evidence: 'e0' },
        { fact_index: 1, verdict: 'stated', evidence: 'e1' },
        { fact_index: 2, verdict: 'absent', evidence: 'e2' },
      ],
    },
    'case-a|0|sentence_support:0': {
      kind: 'sentence_support',
      sentence_index: 0,
      verdict: 'supported',
      span: 's0',
      prompt_hash: 'ph',
      judge_model: 'jm',
    },
    'case-a|0|sentence_support:1': {
      kind: 'sentence_support',
      sentence_index: 1,
      verdict: 'supported',
      span: 's1',
      prompt_hash: 'ph',
      judge_model: 'jm',
    },
    'case-a|0|unsupported_claims:': {
      kind: 'unsupported_claims',
      unsupported_sentence_indices: [2],
      reasons: ['no citations'],
      prompt_hash: 'ph',
      judge_model: 'jm',
    },
  },
})

const makeLabels = (over: Partial<HumanLabels> = {}): HumanLabels => ({
  schema: 'answer-eval/human-labels@1',
  capture_file: 'capture.json',
  // Labels must carry THIS capture's fingerprint for the join paths.
  capture_fingerprint: captureFingerprint(makeCapture()),
  case_id: 'case-a',
  pass: 0,
  reviewer: 'r1',
  fact_verdicts: [
    { fact_index: 0, verdict: 'stated' },
    { fact_index: 1, verdict: 'partial' },
    { fact_index: 2, verdict: 'absent' },
  ],
  sentence_verdicts: [
    { sentence_index: 0, verdict: 'supported' },
    { sentence_index: 1, verdict: 'unsupported' },
    { sentence_index: 2, verdict: 'unsupported' },
  ],
  ...over,
})

const ORIGIN = 'labels/x.json'

describe('parseLabels', () => {
  it('accepts the full schema', () => {
    const labels = makeLabels({
      question: 'q',
      key_facts: ['f0'],
      overall_note: 'n',
    })
    expect(parseLabels(JSON.stringify(labels), ORIGIN)).toEqual(labels)
  })

  it('rejects a wrong schema string, naming the origin', () => {
    expect(() =>
      parseLabels(
        JSON.stringify(makeLabels({ schema: 'answer-eval/human-labels@2' })),
        ORIGIN,
      ),
    ).toThrow(ORIGIN)
  })

  it('rejects a short fingerprint, naming the origin', () => {
    expect(() =>
      parseLabels(
        JSON.stringify(makeLabels({ capture_fingerprint: 'deadbeef' })),
        ORIGIN,
      ),
    ).toThrow(ORIGIN)
  })

  it('rejects an empty reviewer, naming the origin', () => {
    expect(() =>
      parseLabels(JSON.stringify(makeLabels({ reviewer: '' })), ORIGIN),
    ).toThrow(ORIGIN)
  })

  it('rejects a bad fact verdict enum, naming the origin', () => {
    expect(() =>
      parseLabels(
        JSON.stringify(
          makeLabels({
            fact_verdicts: [{ fact_index: 0, verdict: 'statedx' }],
          }),
        ),
        ORIGIN,
      ),
    ).toThrow(ORIGIN)
  })

  it('rejects a negative sentence_index, naming the origin', () => {
    expect(() =>
      parseLabels(
        JSON.stringify(
          makeLabels({
            sentence_verdicts: [{ sentence_index: -1, verdict: 'supported' }],
          }),
        ),
        ORIGIN,
      ),
    ).toThrow(ORIGIN)
  })

  it('rejects a non-integer pass, naming the origin', () => {
    expect(() =>
      parseLabels(JSON.stringify(makeLabels({ pass: 1.5 })), ORIGIN),
    ).toThrow(ORIGIN)
  })

  it('rejects non-JSON text, naming the origin', () => {
    expect(() => parseLabels('{not json', ORIGIN)).toThrow(ORIGIN)
  })
})

describe('loadLabelsFrom', () => {
  it('reads a dir sorted, labels-*.json only (mode-1 annot files share review-output/)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-test-'))
    fs.writeFileSync(
      path.join(dir, 'labels-b.json'),
      JSON.stringify(makeLabels({ case_id: 'case-b', reviewer: 'rb' })),
    )
    fs.writeFileSync(
      path.join(dir, 'labels-a.json'),
      JSON.stringify(makeLabels({ case_id: 'case-a2', reviewer: 'ra' })),
    )
    fs.writeFileSync(path.join(dir, 'skip.txt'), 'not json')
    // The evalset-review notebook writes annot-*.json into the same dir.
    fs.writeFileSync(
      path.join(dir, 'annot-evalset_answer_02-q1-by-r.json'),
      JSON.stringify({ query_id: 'q1', reviewer: 'r', reviewed_passages: [] }),
    )
    try {
      const loaded = loadLabelsFrom([dir])
      expect(loaded.map((l) => l.case_id)).toEqual(['case-a2', 'case-b'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a single file path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-test-'))
    const file = path.join(dir, 'one.json')
    fs.writeFileSync(file, JSON.stringify(makeLabels({ reviewer: 'r-one' })))
    try {
      const loaded = loadLabelsFrom([file])
      expect(loaded).toHaveLength(1)
      expect(loaded[0].reviewer).toBe('r-one')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('validateLabelsAgainstCapture', () => {
  it('accepts matching fingerprint, case, and pass', () => {
    expect(validateLabelsAgainstCapture(makeLabels(), makeCapture())).toEqual({
      ok: true,
    })
  })

  it('reports a fingerprint mismatch', () => {
    const r = validateLabelsAgainstCapture(
      makeLabels({ capture_fingerprint: 'b'.repeat(64) }),
      makeCapture(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/fingerprint/)
  })

  it('reports an unknown case', () => {
    const r = validateLabelsAgainstCapture(
      makeLabels({ case_id: 'nope' }),
      makeCapture(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/nope/)
  })

  it('reports an unknown pass for a known case', () => {
    const r = validateLabelsAgainstCapture(
      makeLabels({ pass: 7 }),
      makeCapture(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/pass/)
  })

  it('reports a fact_index beyond the case key_facts', () => {
    // case-a has 3 key facts (indices 0..2)
    const r = validateLabelsAgainstCapture(
      makeLabels({ fact_verdicts: [{ fact_index: 3, verdict: 'stated' }] }),
      makeCapture(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/fact_index 3/)
  })

  it('reports a sentence_index beyond the pass sentences', () => {
    // case-a|0 has 3 sentences (indices 0..2)
    const r = validateLabelsAgainstCapture(
      makeLabels({
        sentence_verdicts: [{ sentence_index: 3, verdict: 'supported' }],
      }),
      makeCapture(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/sentence_index 3/)
  })
})

describe('captureFingerprint pin', () => {
  it('matches the hex PR A asserts', () => {
    const fixture = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, 'fixtures', 'capture-fingerprint-pin.json'),
        'utf8',
      ),
    )
    expect(captureFingerprint(fixture as CaptureArtifact)).toBe(PIN_HEX)
  })
})

describe('judgeHumanAgreement', () => {
  it('tallies judge-vs-human verdicts with the symmetric either-denominator', () => {
    const agreement = judgeHumanAgreement(
      makeJudged(),
      [makeLabels()],
      makeCapture(),
    )
    // facts: judge stated/stated/absent vs human stated/partial/absent
    expect(agreement.fact_recall.stated.agree).toEqual({ stated: 1 })
    expect(agreement.fact_recall.stated.either).toEqual({ stated: 2 })
    expect(agreement.fact_recall.partial.agree).toEqual({})
    expect(agreement.fact_recall.partial.either).toEqual({ partial: 1 })
    expect(agreement.fact_recall.absent.agree).toEqual({ absent: 1 })
    expect(agreement.fact_recall.absent.either).toEqual({ absent: 1 })
    expect(agreement.fact_recall.stated.excluded).toBe(0)
    expect(agreement.fact_recall.partial.excluded).toBe(0)
    expect(agreement.fact_recall.absent.excluded).toBe(0)
    // cited sentences: judge supported/supported vs human supported/unsupported
    expect(agreement.sentence_support.supported.agree).toEqual({
      supported: 1,
    })
    expect(agreement.sentence_support.supported.either).toEqual({
      supported: 2,
    })
    expect(agreement.sentence_support.unsupported.agree).toEqual({})
    expect(agreement.sentence_support.unsupported.either).toEqual({
      unsupported: 1,
    })
    // zero-cite s2 joins ONLY through unsupported_claims — never excluded
    expect(agreement.sentence_support.supported.excluded).toBe(0)
    expect(agreement.sentence_support.unsupported.excluded).toBe(0)
    // s0 supported/not-listed agree; s1 unsupported/not-listed disagree;
    // s2 unsupported/listed agree
    expect(agreement.unsupported_claims).toEqual({ agree: 2, compared: 3 })
    expect(agreement.labels).toBe(1)
    expect(agreement.reviewers).toEqual(['r1'])
  })

  it('counts a (case,pass) with no judged items as excluded per verdict type', () => {
    const agreement = judgeHumanAgreement(
      makeJudged(),
      [
        makeLabels({
          case_id: 'case-b',
          reviewer: 'rb',
          fact_verdicts: [{ fact_index: 0, verdict: 'stated' }],
          sentence_verdicts: [
            { sentence_index: 0, verdict: 'supported' },
            { sentence_index: 1, verdict: 'unsupported' },
          ],
        }),
      ],
      makeCapture(),
    )
    expect(agreement.fact_recall.stated.excluded).toBe(1)
    // t0 is cited but unjudged → excluded; t1 is zero-cite → unsupported_claims
    expect(agreement.sentence_support.supported.excluded).toBe(1)
    expect(agreement.sentence_support.unsupported.excluded).toBe(0)
    // no judged unsupported_claims item → nothing compared
    expect(agreement.unsupported_claims).toEqual({ agree: 0, compared: 0 })
  })

  it('counts a human verdict for an unjudged fact as excluded', () => {
    const judged = makeJudged()
    judged.items['case-a|0|fact_recall:'] = {
      kind: 'fact_recall',
      prompt_hash: 'ph',
      judge_model: 'jm',
      unjudged: { reason: 'rate_limited', raw: '' },
    } as any
    const agreement = judgeHumanAgreement(
      judged,
      [
        makeLabels({
          fact_verdicts: [{ fact_index: 0, verdict: 'stated' }],
          sentence_verdicts: [],
        }),
      ],
      makeCapture(),
    )
    expect(agreement.fact_recall.stated.excluded).toBe(1)
    expect(agreement.fact_recall.stated.either).toEqual({})
  })

  it('counts a judged verdict outside the enum as excluded instead of throwing', () => {
    const judged = makeJudged()
    const fr = judged.items['case-a|0|fact_recall:'] as any
    fr.verdicts[0].verdict = 'maybe' // hand-edited artifact
    const ss = judged.items['case-a|0|sentence_support:0'] as any
    ss.verdict = 'kinda'
    const agreement = judgeHumanAgreement(
      judged,
      [
        makeLabels({
          fact_verdicts: [{ fact_index: 0, verdict: 'stated' }],
          sentence_verdicts: [{ sentence_index: 0, verdict: 'supported' }],
        }),
      ],
      makeCapture(),
    )
    expect(agreement.fact_recall.stated.excluded).toBe(1)
    expect(agreement.fact_recall.stated.either).toEqual({})
    expect(agreement.sentence_support.supported.excluded).toBe(1)
    expect(agreement.sentence_support.supported.either).toEqual({})
  })

  it('joins multiple reviewers independently and dedupes same-reviewer last-wins', () => {
    const agreement = judgeHumanAgreement(
      makeJudged(),
      [
        makeLabels({
          fact_verdicts: [{ fact_index: 0, verdict: 'stated' }],
          sentence_verdicts: [],
        }),
        // same reviewer again — the later file wins for (case, pass)
        makeLabels({
          fact_verdicts: [{ fact_index: 0, verdict: 'absent' }],
          sentence_verdicts: [],
        }),
        makeLabels({
          reviewer: 'r2',
          fact_verdicts: [{ fact_index: 0, verdict: 'stated' }],
          sentence_verdicts: [],
        }),
      ],
      makeCapture(),
    )
    expect(agreement.labels).toBe(2)
    expect(agreement.reviewers).toEqual(['r1', 'r2'])
    // r2 agreed (stated=stated); r1's effective absent disagreed with judged stated
    expect(agreement.fact_recall.stated.agree).toEqual({ stated: 1 })
    expect(agreement.fact_recall.stated.either).toEqual({ stated: 2 })
    expect(agreement.fact_recall.absent.either).toEqual({ absent: 1 })
  })

  it('is deterministic for identical inputs', () => {
    const a = judgeHumanAgreement(makeJudged(), [makeLabels()], makeCapture())
    const b = judgeHumanAgreement(makeJudged(), [makeLabels()], makeCapture())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
