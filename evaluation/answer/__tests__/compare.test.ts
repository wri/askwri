/** @jest-environment node */
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import {
  PairwiseArtifact,
  compareReports,
  judgedAgreement,
  pairwiseSummary,
  runPairwise,
} from '../compare'
import { captureFingerprint } from '../judge'
import { judgeCall } from '../judge-client'
import {
  PAIRWISE_SYSTEM,
  PROMPT_HASHES,
  pairwiseUser,
  validatePairwise,
} from '../judge-prompts'
import {
  CaptureArtifact,
  CaseCapture,
  JudgedArtifact,
  JudgedItem,
  PassCapture,
  PassageSent,
  Provenance,
  Report,
} from '../types'
import { close, listen, readJsonBody, respondJson } from '../test-server'

// ---------------------------------------------------------------------------
// shared fixtures
// ---------------------------------------------------------------------------

const provenance = (commit: string, passes: number): Provenance => ({
  fixture: { path: '/tmp/evalset.json', name: 'compare-test', commit },
  target: { mode: 'gateway', urls: ['http://t'], config: null },
  knobs: { retrieval: {}, synthesis: {} },
  synthesis: { model: 'synth', base_url: 'http://synth', prompt_hashes: {} },
  passes,
  harness_sha: 'harnesssha',
  timestamp: '2026-09-05T12:00:00Z',
  node_version: process.version,
})

const makeReport = (
  prov: Provenance,
  perCase: Array<Record<string, unknown>>,
): Report => ({
  schema: 'answer-eval/report@1',
  provenance: prov,
  header: {},
  headline: {},
  draft_block: {},
  per_case: perCase,
})

/** Positive case row with a pass spread on evidence_coverage. */
const posRow = (
  id: string,
  ec: number,
  ecPasses: number[],
): Record<string, unknown> => ({
  id,
  review_status: 'expert_approved',
  evidence_coverage: ec,
  fact_recall_strict: 0.5,
  per_pass: ecPasses.map((v, i) => ({
    pass: i,
    evidence_coverage: v,
    fact_recall_strict: 0.5,
  })),
})

/** Negative case row: abstention over passes. */
const negRow = (id: string): Record<string, unknown> => ({
  id,
  review_status: 'draft',
  abstention_rate: 0.5,
  per_pass: [
    { pass: 0, abstained: true },
    { pass: 1, abstained: false },
  ],
})

const reportA = makeReport(provenance('sha0000', 2), [
  posRow('q1', 0.75, [1, 0.5]),
  negRow('q2'),
])
const reportB = makeReport(provenance('sha0000', 2), [
  posRow('q1', 1, [1, 1]),
  negRow('q2'),
])

// ---------------------------------------------------------------------------
// compareReports — guard (§6)
// ---------------------------------------------------------------------------

describe('compareReports — guard', () => {
  it('refuses differing fixture commits', () => {
    const other = makeReport(provenance('shaZZZZ', 2), reportB.per_case)
    expect(() => compareReports(reportA, other)).toThrow(/fixture commit/)
  })

  it('refuses differing pass counts', () => {
    const other = makeReport(provenance('sha0000', 3), reportB.per_case)
    expect(() => compareReports(reportA, other)).toThrow(/pass count/)
  })

  it('refuses differing case sets', () => {
    const other = makeReport(provenance('sha0000', 2), [
      posRow('q1', 1, [1, 1]),
      posRow('q9', 1, [1, 1]),
    ])
    expect(() => compareReports(reportA, other)).toThrow(/case set/)
  })

  it('refuses differing target modes (gateway chunk text ≠ direct chunk text)', () => {
    const prov = provenance('sha0000', 2)
    const other = makeReport(
      { ...prov, target: { ...prov.target, mode: 'direct' } },
      reportB.per_case,
    )
    expect(() => compareReports(reportA, other)).toThrow(/target mode/)
  })
})

describe('compareReports — block deltas', () => {
  const block = (ec: number, count: number) => ({
    cases: 1,
    retrieval: { evidence_coverage: { mean: ec, cases: 1 } },
    synthesis: {
      fact_recall_strict: { mean: null, cases: 0 },
      unsupported_claims_count: count,
    },
  })
  it('prints headline and draft block deltas ahead of the per-case rows', () => {
    const a = { ...reportA, headline: block(0.5, 3), draft_block: block(1, 0) }
    const b = { ...reportB, headline: block(0.75, 1), draft_block: block(1, 0) }
    const out = compareReports(a, b)
    const headlineAt = out.indexOf('headline')
    expect(headlineAt).toBeGreaterThan(-1)
    expect(headlineAt).toBeLessThan(out.indexOf('q1 ('))
    const headline = out.slice(headlineAt, out.indexOf('draft'))
    expect(headline).toContain('evidence_coverage')
    expect(headline).toContain('A 0.500')
    expect(headline).toContain('B 0.750')
    expect(headline).toContain('Δ +0.250')
    expect(headline).toContain('fact_recall_strict')
    expect(headline).toContain('n/a')
    expect(headline).toContain('unsupported_claims_count')
    expect(headline).toContain('Δ -2')
  })

  it('spread ignores excluded passes (an excluded pass is not a non-abstention)', () => {
    const row = {
      id: 'q1',
      review_status: 'draft',
      abstention_rate: 1,
      per_pass: [
        { pass: 0, abstained: true },
        { pass: 1, excluded: 'retrieval_error' },
      ],
    }
    const a = makeReport(provenance('sha0000', 2), [row])
    const out = compareReports(a, a)
    expect(out).toContain('[1.000–1.000]')
    expect(out).not.toContain('0.000–1.000')
  })
})

describe('compareReports — deltas', () => {
  it('prints per-case deltas with the per-pass spread for every metric present', () => {
    const out = compareReports(reportA, reportB)
    expect(out).toContain('q1')
    expect(out).toContain('evidence_coverage')
    expect(out).toContain('0.500–1.000') // A spread
    expect(out).toContain('1.000–1.000') // B spread
    expect(out).toContain('Δ +0.250')
    expect(out).toContain('q2')
    expect(out).toContain('abstention_rate')
    expect(out).toContain('0.000–1.000')
  })
})

// ---------------------------------------------------------------------------
// judgedAgreement
// ---------------------------------------------------------------------------

const evalsetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-agree-'))
const evalsetPath = path.join(evalsetDir, 'evalset.json')
fs.writeFileSync(
  evalsetPath,
  JSON.stringify({
    name: 'compare-test',
    test_cases: [
      {
        id: 'q1',
        question: 'q?',
        source_language: 'zh',
        retrieval_ground_truth: {
          expected_passages: [
            { doc_id: 'd1', chunk_id: 'c1', text_snippet: '中文片段' },
          ],
        },
      },
      {
        id: 'q2',
        question: 'q?',
        retrieval_ground_truth: {
          expected_passages: [
            { doc_id: 'd2', chunk_id: 'c2', text_snippet: 'english snippet' },
          ],
        },
      },
      {
        id: 'q3',
        question: 'q?',
        retrieval_ground_truth: {
          expected_passages: [
            { doc_id: 'd3', chunk_id: 'c3', text_snippet: '另一段中文' },
          ],
        },
      },
    ],
  }),
)

const judgeProvenance = (): Provenance => ({
  ...provenance('sha0000', 1),
  fixture: { ...provenance('sha0000', 1).fixture, path: evalsetPath },
})

const jc = { prompt_hash: 'ph', judge_model: 'model-x' }
const fact = (
  verdicts: Array<{
    fact_index: number
    verdict: 'stated' | 'partial' | 'absent'
  }>,
): JudgedItem =>
  ({
    kind: 'fact_recall',
    verdicts: verdicts.map((v) => ({ ...v, evidence: 'e' })),
    ...jc,
  }) as JudgedItem
const sent = (i: number, verdict: 'supported' | 'unsupported'): JudgedItem => ({
  kind: 'sentence_support',
  sentence_index: i,
  verdict,
  span: 'span',
  ...jc,
})

/**
 * Hand-built pair with exactly ONE disagreement (q1 fact 1: partial vs
 * absent). Comparable positions: q1f0, q1f1, q1s0, q2f0, q2f1, q2s0, q2s1,
 * q3f0 = 8 → overall 7/8 (87.5%).
 * - zh (q1, q3): stated 1/1, partial 1/2 (q1f1 + q3f0), absent 0/1,
 *   supported 1/1, unsupported 0/0 (n/a), excluded 1 (q1|1 fact, A only).
 * - en (q2): stated 1/1, partial 0/0 (n/a), absent 1/1, supported 1/1,
 *   unsupported 1/1, excluded 1 (q2|1 sentence unjudged in B).
 */
const judgedA: JudgedArtifact = {
  schema: 'answer-eval/judged@1',
  provenance: judgeProvenance(),
  items: {
    'q1|0|fact_recall:': fact([
      { fact_index: 0, verdict: 'stated' },
      { fact_index: 1, verdict: 'partial' },
    ]),
    'q1|0|sentence_support:0': sent(0, 'supported'),
    'q1|1|fact_recall:': fact([{ fact_index: 0, verdict: 'stated' }]),
    'q2|0|fact_recall:': fact([
      { fact_index: 0, verdict: 'stated' },
      { fact_index: 1, verdict: 'absent' },
    ]),
    'q2|0|sentence_support:0': sent(0, 'supported'),
    'q2|0|sentence_support:1': sent(1, 'unsupported'),
    'q2|1|sentence_support:0': sent(0, 'supported'),
    'q3|0|fact_recall:': fact([{ fact_index: 0, verdict: 'partial' }]),
  },
}

const judgedB: JudgedArtifact = {
  schema: 'answer-eval/judged@1',
  provenance: judgeProvenance(),
  items: {
    'q1|0|fact_recall:': fact([
      { fact_index: 0, verdict: 'stated' },
      { fact_index: 1, verdict: 'absent' },
    ]),
    'q1|0|sentence_support:0': sent(0, 'supported'),
    'q2|0|fact_recall:': fact([
      { fact_index: 0, verdict: 'stated' },
      { fact_index: 1, verdict: 'absent' },
    ]),
    'q2|0|sentence_support:0': sent(0, 'supported'),
    'q2|0|sentence_support:1': sent(1, 'unsupported'),
    'q2|1|sentence_support:0': {
      kind: 'sentence_support',
      ...jc,
      unjudged: { reason: 'judge 401', raw: 'auth error' },
    } as unknown as JudgedItem,
    'q3|0|fact_recall:': fact([{ fact_index: 0, verdict: 'partial' }]),
  },
}

describe('judgedAgreement', () => {
  it('computes per-verdict-type agreement, split by source language, with excluded counts', () => {
    const out = judgedAgreement(judgedA, judgedB)
    // zh-source (q1 via source_language, q3 via zh-snippet fallback)
    expect(out).toContain('zh-source cases')
    expect(out).toContain('stated 1/1 (100.0%)')
    expect(out).toContain('partial 1/2 (50.0%)')
    expect(out).toContain('absent 0/1 (0.0%)')
    expect(out).toContain('supported 1/1 (100.0%)')
    // en-source (q2 via latin-snippet fallback)
    // Bucket label is 'non-zh' (an es-source case lands here too, not
    // under an 'english' label).
    expect(out).toContain('non-zh-source cases')
    expect(out).toContain('unsupported 1/1 (100.0%)')
    // excluded: present-in-one / unjudged items, counted per language bucket
    expect(out).toContain('excluded items: 1')
    // one disagreement across 8 comparable positions
    expect(out).toContain('overall agreement: 7/8 (87.5%)')
  })

  it('refuses judged artifacts from different fixture commits', () => {
    const other = { ...judgedB, provenance: judgeProvenance() }
    other.provenance = {
      ...other.provenance,
      fixture: { ...other.provenance.fixture, commit: 'shaZZZZ' },
    }
    expect(() => judgedAgreement(judgedA, other)).toThrow(/fixture commit/)
  })
})

// ---------------------------------------------------------------------------
// pairwise prompt (judge-prompts.ts additions)
// ---------------------------------------------------------------------------

describe('pairwise prompt', () => {
  it('PROMPT_HASHES carries the pairwise entry and the validator enforces the schema', () => {
    expect(typeof PROMPT_HASHES.pairwise).toBe('string')
    expect(PROMPT_HASHES.pairwise).not.toBe('')
    expect(validatePairwise({ preferred: 'one', reason: 'why' })).toEqual({
      preferred: 'one',
      reason: 'why',
    })
    expect(
      validatePairwise({ preferred: 'left', reason: 'why' }),
    ).toBeInstanceOf(Error)
    expect(validatePairwise({ preferred: 'tie' })).toBeInstanceOf(Error)
    expect(validatePairwise({ preferred: 'tie', reason: '' })).toBeInstanceOf(
      Error,
    )
  })

  it('pairwiseUser language-tags the shared passages and labels both answers', () => {
    const u = pairwiseUser(
      'q?',
      [{ text: '中文段落' }, { text: 'english' }],
      'answer one text',
      'answer two text',
    )
    expect(u).toContain('Question:\nq?')
    expect(u).toContain('(zh): 中文段落')
    expect(u).toContain('(latin): english')
    expect(u).toContain('Answer one:\nanswer one text')
    expect(u).toContain('Answer two:\nanswer two text')
  })
})

// ---------------------------------------------------------------------------
// runPairwise
// ---------------------------------------------------------------------------

const A_TEXT = 'Trucks carry most freight.'
const B_TEXT = 'Rail carries the most freight.'
const PASSAGE_TEXTS: Record<string, string> = {
  c1: '中文共享段落一',
  c2: 'english shared passage',
  cA: 'passage only in capture A',
  cB: 'passage only in capture B',
}

const passage = (id: number, chunkId: string): PassageSent => ({
  id,
  doc_id: `doc-${chunkId}`,
  chunk_id: chunkId,
  page: 1,
  text: PASSAGE_TEXTS[chunkId],
})

const makePass = (
  pass: number,
  chunkIds: string[],
  sentences: string[],
): PassCapture => ({
  pass,
  retrieval: {
    chunks: [],
    likely_off_topic: false,
    service_ms: 1,
    cost_usd: null,
    wall_ms: 1,
  },
  answer: {
    knobs: {},
    passages_sent: chunkIds.map((c, i) => passage(i + 1, c)),
    sentences,
    cites: [],
    raw_model_json: '{}',
    low_coverage: false,
    invalid_cites: 0,
    wall_ms: 1,
  },
})

const makeCase = (id: string, passes: PassCapture[]): CaseCapture => ({
  case_id: id,
  fixture_case: { id, question: 'How is freight moved?' },
  passes,
})

const makeCapture = (
  commit: string,
  cases: CaseCapture[],
  passes: number,
): CaptureArtifact => ({
  schema: 'answer-eval/capture@1',
  provenance: provenance(commit, passes),
  preflight: {
    corpus_ok: true,
    missing_docs: [],
    snippet_failures: [],
    twins_ok: true,
    synthesis_probe_ok: true,
    judge_probe_ok: true,
    approved: 1,
    draft: 0,
    rejected: 0,
    estimated_calls: { retrieval: 0, synthesis: 0, judge: 0 },
  },
  cases,
})

/** A: passages c1, c2, cA; B: c1, c2, cB — shared: c1, c2. */
const capA = makeCapture(
  'sha0000',
  [makeCase('q1', [makePass(0, ['c1', 'c2', 'cA'], [A_TEXT])])],
  1,
)
const capB = makeCapture(
  'sha0000',
  [makeCase('q1', [makePass(0, ['c1', 'c2', 'cB'], [B_TEXT])])],
  1,
)
/** Two passes for the resume test. */
const capA2 = makeCapture(
  'sha0000',
  [
    makeCase('q1', [
      makePass(0, ['c1', 'c2', 'cA'], [A_TEXT]),
      makePass(1, ['c1', 'c2', 'cA'], [A_TEXT]),
    ]),
  ],
  2,
)
const capB2 = makeCapture(
  'sha0000',
  [
    makeCase('q1', [
      makePass(0, ['c1', 'c2', 'cB'], [B_TEXT]),
      makePass(1, ['c1', 'c2', 'cB'], [B_TEXT]),
    ]),
  ],
  2,
)

/**
 * Fake judge: 'a' prefers A's answer, 'b' prefers B's, 'first' prefers
 * whichever answer is presented as "Answer one" (position bias). Records
 * every user prompt.
 */
const preferJudge =
  (mode: 'a' | 'b' | 'first', users: string[], counter: { n: number }) =>
  async (p: any) => {
    users.push(p.user)
    counter.n++
    const aFirst = p.user.indexOf(A_TEXT) < p.user.indexOf(B_TEXT)
    const preferred =
      mode === 'first' ? 'one' : (mode === 'a') === aFirst ? 'one' : 'two'
    return {
      ok: true,
      verdict: { preferred, reason: `reason-${mode}` },
      prompt_hash: PROMPT_HASHES.pairwise,
      judge_model: p.judgeModel,
    }
  }

const pairwiseFile = (): string =>
  path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pairwise-')),
    'pairwise.json',
  )

const runOn = (
  judge: any,
  captureA = capA,
  captureB = capB,
  rng = () => 0.4,
  pairwisePath = pairwiseFile(),
) =>
  runPairwise({
    captureA,
    captureB,
    labelA: 'A',
    labelB: 'B',
    pairwisePath,
    judge,
    judgeModel: 'glm-test',
    rng,
  })

function silenceConsole(): { restore: () => void } {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {})
  const err = jest.spyOn(console, 'error').mockImplementation(() => {})
  return { restore: () => ((log as any).mockRestore(), err.mockRestore()) }
}

describe('runPairwise', () => {
  it('counts a win for A only when A wins in both orders', async () => {
    const users: string[] = []
    const c = { n: 0 }
    const c2 = { n: 0 }
    const s = silenceConsole()
    let artifact
    let artifactFlipped
    try {
      artifact = await runOn(preferJudge('a', users, c))
      artifactFlipped = await runOn(
        preferJudge('a', [], c2),
        capA,
        capB,
        () => 0.9,
      )
    } finally {
      s.restore()
    }
    const item = artifact.items['q1|0']
    expect(item.orderAB).toBe('a')
    expect(item.orderBA).toBe('a')
    expect(item.reason).toBe('reason-a')
    expect(item.case).toBe('q1')
    expect(item.pass).toBe(0)
    // Each (case,pass) pair = 2 judge calls (both orders).
    expect(c.n).toBe(2)
    // The rng flip changes which run comes first, not the stored verdicts.
    expect(artifactFlipped.items['q1|0']).toMatchObject({
      orderAB: 'a',
      orderBA: 'a',
    })
    // Order follows the rng: run 1 A-first, run 2 swapped.
    expect(users[0].indexOf(A_TEXT)).toBeLessThan(users[0].indexOf(B_TEXT))
    expect(users[1].indexOf(B_TEXT)).toBeLessThan(users[1].indexOf(A_TEXT))
    const summary = pairwiseSummary(artifact)
    expect(summary).toContain('A wins both orders: 1')
    expect(summary).toContain('B wins both orders: 0')
  })

  it('surfaces split verdicts as position bias, not a win', async () => {
    const s = silenceConsole()
    let artifact
    try {
      artifact = await runOn(preferJudge('first', [], { n: 0 }))
    } finally {
      s.restore()
    }
    expect(artifact.items['q1|0']).toMatchObject({ orderAB: 'a', orderBA: 'b' })
    const summary = pairwiseSummary(artifact)
    expect(summary).toContain('A wins both orders: 0')
    expect(summary).toContain('position bias (preference flips with order): 1')
  })

  it('sends only shared passages (chunk_id in both captures), language-tagged, and swaps order across runs', async () => {
    const requests: any[] = []
    const server = http.createServer((req, res) => {
      readJsonBody(req, (body) => {
        requests.push(body)
        respondJson(res, 200, {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  preferred: 'one',
                  reason: 'first presented is better',
                }),
              },
            },
          ],
        })
      })
    })
    const url = await listen(server)
    const savedLunaroute = process.env.LUNAROUTE_BASE_URL
    const savedKey = process.env.LUNAROUTE_API_KEY
    process.env.LUNAROUTE_BASE_URL = url
    process.env.LUNAROUTE_API_KEY = 'test-key'
    const s = silenceConsole()
    let artifact
    try {
      artifact = await runPairwise({
        captureA: capA,
        captureB: capB,
        labelA: 'A',
        labelB: 'B',
        pairwisePath: pairwiseFile(),
        judge: judgeCall,
        judgeModel: 'glm-test',
        judgeBaseUrl: url,
        rng: () => 0.4,
      })
    } finally {
      s.restore()
      process.env.LUNAROUTE_BASE_URL = savedLunaroute
      process.env.LUNAROUTE_API_KEY = savedKey
      await close(server)
    }
    expect(requests).toHaveLength(2)
    expect(requests[0].messages[0].content).toBe(PAIRWISE_SYSTEM)
    const user0 = requests[0].messages.find(
      (m: any) => m.role === 'user',
    ).content
    expect(user0).toContain('Question:\nHow is freight moved?')
    expect(user0).toContain('(zh): 中文共享段落一')
    expect(user0).toContain('(latin): english shared passage')
    expect(user0).not.toContain('passage only in capture A')
    expect(user0).not.toContain('passage only in capture B')
    expect(user0).toContain(`Answer one:\n${A_TEXT}`)
    expect(user0).toContain(`Answer two:\n${B_TEXT}`)
    const user1 = requests[1].messages.find(
      (m: any) => m.role === 'user',
    ).content
    expect(user1).toContain(`Answer one:\n${B_TEXT}`)
    // judge prefers the first-presented → A first in run 1, B first in run 2
    expect(artifact.items['q1|0']).toMatchObject({
      orderAB: 'a',
      orderBA: 'b',
    })
  })

  it('warns when a pair has no shared passages (the judge would compare answers without evidence)', async () => {
    const disjoint = makeCapture(
      'sha0000',
      [makeCase('q1', [makePass(0, ['cB'], [B_TEXT])])],
      1,
    )
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const s = silenceConsole()
    try {
      await runOn(preferJudge('a', [], { n: 0 }), capA, disjoint)
    } finally {
      s.restore()
    }
    const warned = warn.mock.calls.map((c) => c.join(' ')).join('\n')
    warn.mockRestore()
    expect(warned).toContain('q1|0')
    expect(warned).toContain('no shared passages')
  })

  it('refuses to resume a pairwise artifact whose captures differ (e.g. labels flipped onto the same file)', async () => {
    const file = pairwiseFile()
    const prior: PairwiseArtifact = {
      schema: 'answer-eval/pairwise@1',
      labelA: 'A',
      labelB: 'B',
      judge_model: 'glm-test',
      prompt_hash: PROMPT_HASHES.pairwise,
      // Fingerprints swapped: this file judged B-vs-A.
      fingerprint_a: captureFingerprint(capB2),
      fingerprint_b: captureFingerprint(capA2),
      items: {},
    }
    fs.writeFileSync(file, JSON.stringify(prior))
    await expect(
      runOn(preferJudge('a', [], { n: 0 }), capA2, capB2, () => 0.4, file),
    ).rejects.toThrow(/different capture/)
  })

  it('refuses to resume a pairwise artifact judged by another model or prompt', async () => {
    const file = pairwiseFile()
    const prior: PairwiseArtifact = {
      schema: 'answer-eval/pairwise@1',
      labelA: 'A',
      labelB: 'B',
      judge_model: 'other-judge',
      prompt_hash: PROMPT_HASHES.pairwise,
      fingerprint_a: captureFingerprint(capA2),
      fingerprint_b: captureFingerprint(capB2),
      items: {},
    }
    fs.writeFileSync(file, JSON.stringify(prior))
    await expect(
      runOn(preferJudge('a', [], { n: 0 }), capA2, capB2, () => 0.4, file),
    ).rejects.toThrow(/judge model/)
  })

  it('resumes: pre-written entries are skipped, tombstones retried', async () => {
    const file = pairwiseFile()
    const prior: PairwiseArtifact = {
      schema: 'answer-eval/pairwise@1',
      labelA: 'A',
      labelB: 'B',
      judge_model: 'glm-test',
      prompt_hash: PROMPT_HASHES.pairwise,
      fingerprint_a: captureFingerprint(capA2),
      fingerprint_b: captureFingerprint(capB2),
      items: {
        'q1|0': {
          case: 'q1',
          pass: 0,
          orderAB: 'b',
          orderBA: 'b',
          reason: 'prior reason',
        },
        'q1|1': {
          case: 'q1',
          pass: 1,
          unjudged: { reason: 'validation', raw: 'garbage' },
        },
      },
    }
    fs.writeFileSync(file, JSON.stringify(prior))
    const users: string[] = []
    const c = { n: 0 }
    const s = silenceConsole()
    let artifact
    try {
      artifact = await runOn(
        preferJudge('a', users, c),
        capA2,
        capB2,
        () => 0.4,
        file,
      )
    } finally {
      s.restore()
    }
    // Only q1|1 hit the judge (2 orders); q1|0 untouched.
    expect(c.n).toBe(2)
    expect(artifact.items['q1|0'].reason).toBe('prior reason')
    expect(artifact.items['q1|0'].orderAB).toBe('b')
    expect(artifact.items['q1|1']).toMatchObject({ orderAB: 'a', orderBA: 'a' })
    // The file on disk matches the returned artifact.
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(artifact)
  })

  it('refuses pairwise over mismatched fixture commits', async () => {
    const mismatch = makeCapture(
      'shaZZZZ',
      [makeCase('q1', [makePass(0, ['c1', 'c2', 'cB'], [B_TEXT])])],
      1,
    )
    await expect(
      runOn(preferJudge('a', [], { n: 0 }), capA, mismatch),
    ).rejects.toThrow(/fixture commit/)
  })
})
