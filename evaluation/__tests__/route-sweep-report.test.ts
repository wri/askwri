/** @jest-environment node */

import {
  acceptanceGate,
  artifactPath,
  renderMarkdown,
  summarise,
} from '../route-sweep/report'
import type { CallResult, SweepArtifact } from '../route-sweep/types'
import { MODELS } from '@/config/models'

const MODEL_A = 'gpt-5.4-nano'
const MODEL_B = 'gpt-5.6-luna'
const QUESTION = 'how does the EV market grow?'

/** A batch-why call that passed every mechanical check, for tests to break one
 * field of. One explanation per passage, as the route's contract requires. */
const whyCall = (
  model: string,
  whys: string[],
  over: Partial<CallResult> = {},
): CallResult => ({
  route: 'batch-why',
  case_id: 'q1',
  model,
  request: {
    query: QUESTION,
    mode: 'answer',
    passages: whys.map((_, i) => ({ docTitle: `doc ${i}`, snippet: 'snip' })),
  },
  response: {
    ok: true,
    explanations: whys.map((why) => ({ why })),
    provenance: { model, produced: true },
  },
  provenance: { model, produced: true },
  latency_ms: 1200,
  ...over,
})

/** Translate is the single-output route: one canned string, one row. */
const translateCall = (
  model: string,
  translation: string,
  over: Partial<CallResult> = {},
): CallResult => ({
  route: 'translate',
  case_id: 'q1',
  model,
  request: { text: '在测算新能源重卡', model },
  response: { ok: true, translation, provenance: { model, produced: true } },
  provenance: { model, produced: true },
  latency_ms: 800,
  ...over,
})

/** Alignment is the route whose sanitizer replaces the visible insights with one
 * canned sentence while still reporting `produced: true`. */
const alignmentCall = (
  model: string,
  insights: string[],
  over: Partial<CallResult> = {},
): CallResult => ({
  route: 'alignment',
  case_id: 'q1',
  model,
  request: { query: QUESTION, resultsSummary: 'Results for: anything' },
  response: {
    ok: true,
    assessment: { insights, alignment: 'Moderate' },
    provenance: { model, produced: true },
  },
  provenance: { model, produced: true },
  latency_ms: 900,
  ...over,
})

const CANNED_INSIGHT =
  'Unable to assess alignment. Try providing more sources or refining your query.'

const artifact = (
  calls: CallResult[],
  over: Partial<SweepArtifact> = {},
): SweepArtifact => ({
  label: 'smoke',
  target: 'https://qa.askwrimvp.test',
  models: [MODEL_A, MODEL_B],
  code_version: 'sha256:9f1c2',
  max_results: 8,
  submodule_commit: 'deadbee',
  calls,
  ...over,
})

const lineWith = (md: string, needle: string): string =>
  md.split('\n').find((l) => l.includes(needle)) ??
  (() => {
    throw new Error(`no line containing ${needle}`)
  })()

describe('artifactPath', () => {
  it('names both files under evaluation/baselines with the date and label', () => {
    const paths = artifactPath('smoke', new Date(2026, 10, 12))

    expect(paths.json).toBe(
      'evaluation/baselines/2026-11-12-route-sweep-smoke.json',
    )
    expect(paths.md).toBe(
      'evaluation/baselines/2026-11-12-route-sweep-smoke.md',
    )
  })

  it('pads a single-digit month and day, and uses the local date', () => {
    // 23:30 local is the next day in UTC east of here: the file must be named
    // for the day the operator ran it, so no toISOString anywhere.
    const paths = artifactPath('pad', new Date(2026, 0, 5, 23, 30))

    expect(paths.json).toBe(
      'evaluation/baselines/2026-01-05-route-sweep-pad.json',
    )
    expect(paths.md).toBe('evaluation/baselines/2026-01-05-route-sweep-pad.md')
  })

  it('defaults to today', () => {
    expect(artifactPath('today').md).toMatch(
      /^evaluation\/baselines\/\d{4}-\d{2}-\d{2}-route-sweep-today\.md$/,
    )
  })
})

describe('renderMarkdown', () => {
  it('puts the mechanical check summary before any model output', () => {
    const fallback = translateCall(MODEL_A, 'Substituted.', {
      provenance: {
        model: MODEL_A,
        produced: false,
        fallback_reason: 'upstream 500',
      },
    })
    const md = renderMarkdown(
      artifact([fallback, translateCall(MODEL_B, 'Real translation.')]),
    )

    expect(md).toContain('1 of 2 calls failed')
    expect(md.indexOf('1 of 2 calls failed')).toBeLessThan(
      md.indexOf('Real translation.'),
    )
    // The failing row is named in the summary, before any prose.
    const failingRow = lineWith(md, 'upstream 500')
    expect(failingRow).toContain('translate')
    expect(failingRow).toContain('q1')
  })

  it('does not warn about calls when every call passed', () => {
    const md = renderMarkdown(
      artifact([whyCall(MODEL_A, ['a1']), whyCall(MODEL_B, ['b1'])]),
    )

    expect(md).toContain('All 2 calls passed the mechanical checks.')
    expect(md).not.toContain('NOT EVIDENCE')
  })

  it('prints code version unknown in the header line when it is null', () => {
    const md = renderMarkdown(
      artifact([whyCall(MODEL_A, ['a1']), whyCall(MODEL_B, ['b1'])], {
        code_version: null,
      }),
    )

    const header = md.slice(0, md.indexOf('## batch-why'))
    expect(header).toContain('code version: unknown')
    expect(header).not.toContain('code version: sha256')
    // And said again where the mechanical verdicts are, so an unidentifiable
    // build cannot be skimmed past.
    expect(md).toContain('Code version unknown')
    // Not a footnote: it sits above the first route section, with the rest of
    // the provenance.
    expect(md.indexOf('code version: unknown')).toBeLessThan(
      md.indexOf('## batch-why'),
    )
  })

  it('records the code version when it is known', () => {
    const md = renderMarkdown(
      artifact([whyCall(MODEL_A, ['a1']), whyCall(MODEL_B, ['b1'])]),
    )

    expect(lineWith(md, 'code version:')).toContain('sha256:9f1c2')
    expect(md).not.toContain('Code version unknown')
  })

  it('labels a fallback row as not produced, with its reason', () => {
    const fallback = translateCall(MODEL_A, 'Substituted.', {
      provenance: {
        model: MODEL_A,
        produced: false,
        fallback_reason: 'upstream 500',
      },
    })
    const md = renderMarkdown(
      artifact([fallback, translateCall(MODEL_B, 'Real translation.')]),
    )

    const fallbackRow = lineWith(md, `**${MODEL_A}**`)
    expect(fallbackRow).toContain('NOT EVIDENCE')
    expect(fallbackRow).toContain('substituted text')
    expect(fallbackRow).toContain('upstream 500')

    const producedRow = lineWith(md, `**${MODEL_B}**`)
    expect(producedRow).not.toContain('NOT EVIDENCE')

    // The canned text is still shown, so the reader sees what would ship.
    expect(md).toContain('Substituted.')
  })

  it('marks a sanitized row as substituted and fails its check', () => {
    const md = renderMarkdown(
      artifact([
        alignmentCall(MODEL_A, [CANNED_INSIGHT], {
          provenance: { model: MODEL_A, produced: true, sanitized: true },
        }),
        alignmentCall(MODEL_B, ['A real insight.']),
      ]),
    )

    const sanitizedRow = lineWith(md, `**${MODEL_A}**`)
    expect(sanitizedRow).toContain('sanitized: some text was substituted')
    // Substituted text is not model output, so the acceptance bar for a model
    // swap (zero substitutions) cannot be met by a passing check.
    expect(lineWith(md, '**check:**')).toContain(`✗ ${MODEL_A}`)
    expect(md).not.toContain('All 2 calls passed the mechanical checks.')

    // The clean row carries no caveat, or the marker would say nothing.
    expect(lineWith(md, `**${MODEL_B}**`)).not.toContain('sanitized')
  })

  it('records the evalset, its review-tier note and the missing English control in the header', () => {
    const md = renderMarkdown(
      artifact([whyCall(MODEL_A, ['a1']), whyCall(MODEL_B, ['b1'])], {
        evalset: 'evalset_answer_02.json',
        evalset_note:
          'no expert_approved case in evalset_answer_02.json; the first 10 in file order were used',
      }),
    )

    const header = md.slice(0, md.indexOf('## batch-why'))
    expect(lineWith(md, '- evalset:')).toContain('evalset_answer_02.json')
    expect(header).toContain('no expert_approved case')
    expect(header).toContain(
      'No English control case: every case is non-English, so a regression ' +
        'that appears only on English input would not show here.',
    )
  })

  it('names where the documents were frozen only when it is not the swept host', () => {
    const sameHost = renderMarkdown(
      artifact([whyCall(MODEL_A, ['a1'])], {
        frozen_target: 'https://qa.askwrimvp.test',
      }),
    )
    expect(sameHost).not.toContain('documents frozen at')

    const otherHost = renderMarkdown(
      artifact([whyCall(MODEL_A, ['a1'])], {
        frozen_target: 'https://elsewhere.askwrimvp.test',
      }),
    )
    const header = otherHost.slice(0, otherHost.indexOf('## batch-why'))
    expect(header).toContain(
      'documents frozen at: https://elsewhere.askwrimvp.test',
    )
    expect(header).toContain('target: https://qa.askwrimvp.test')
  })

  it('says nothing about the evalset when the artifact does not record one', () => {
    const md = renderMarkdown(artifact([whyCall(MODEL_A, ['a1'])]))

    expect(md).not.toContain('- evalset')
  })

  it('shows both models for a case on one screen worth of lines', () => {
    const md = renderMarkdown(
      artifact([
        whyCall(MODEL_A, ['a1', 'a2']),
        whyCall(MODEL_B, ['b1', 'b2']),
      ]),
    )

    const section = md.slice(md.indexOf('## batch-why'))
    expect(section).toContain(QUESTION)
    expect(section).toContain(MODEL_A)
    expect(section).toContain(MODEL_B)
    expect(section).toContain('a1')
    expect(section).toContain('a2')
    expect(section).toContain('b1')
    expect(section).toContain('b2')

    // Stacked, per model: everything mentioning A comes before B's outputs.
    expect(section.indexOf('a2')).toBeLessThan(section.indexOf('b1'))

    // Human-visible fields only: no raw payloads or JSON dumps.
    expect(section).not.toContain('"passages"')
    expect(section).not.toContain('{"')
    const nonEmpty = section.split('\n').filter((l) => l.trim() !== '')
    expect(nonEmpty.length).toBeLessThanOrEqual(12)
  })

  it('counts inputs from the request, so a short response fails the check', () => {
    const short = whyCall(MODEL_A, ['only one'])
    const withThreePassages: CallResult = {
      ...short,
      request: {
        ...(short.request as any),
        passages: [{}, {}, {}],
      },
    }
    const md = renderMarkdown(
      artifact([withThreePassages, whyCall(MODEL_B, ['b1'])]),
    )

    expect(md).toContain('expected 3 output(s), got 1')
  })

  it('lists a zero-document case as not run, and a case with no calls as not run', () => {
    const md = renderMarkdown(
      artifact([whyCall(MODEL_A, ['a1']), whyCall(MODEL_B, ['b1'])], {
        cases: [
          { id: 'q1', question: QUESTION, doc_count: 2 },
          {
            id: 'q2',
            question: 'nothing came back for this one',
            doc_count: 0,
          },
          { id: 'q3', question: 'sweep stopped before this one', doc_count: 3 },
        ],
      }),
    )

    const noDocs = lineWith(md, 'q2')
    expect(noDocs).toContain('nothing came back for this one')
    expect(noDocs).toContain('not run (no documents)')

    const noCalls = lineWith(md, 'q3')
    expect(noCalls).toContain('not run (no calls recorded)')
    expect(noCalls).not.toContain('no documents')

    // The ran case is not reported as skipped.
    expect(md).not.toContain('q1: not run')
  })

  it('says nothing about skipped cases when the artifact carries no roster', () => {
    const md = renderMarkdown(
      artifact([whyCall(MODEL_A, ['a1']), whyCall(MODEL_B, ['b1'])]),
    )

    expect(md).not.toContain('not run')
  })

  it('renders every route it was given, and leaves out the ones it was not', () => {
    const md = renderMarkdown(
      artifact([translateCall(MODEL_A, '甲'), translateCall(MODEL_B, '乙')]),
    )

    expect(md).toContain('## translate')
    expect(md).toContain('甲')
    expect(md).toContain('乙')
    expect(md).not.toContain('## batch-why')
    expect(md).not.toContain('## alignment')
  })

  it('heads a case with its id alone when the payload carries no question', () => {
    // translate's payload carries a snippet, not the query: the readout shows
    // the id rather than inventing a question or printing the id twice.
    const md = renderMarkdown(
      artifact([translateCall(MODEL_A, '甲'), translateCall(MODEL_B, '乙')]),
    )

    expect(md).toContain('### q1\n')
    expect(md).not.toContain('### q1: q1')
  })

  it('takes the question from the roster for a route whose payload has no question', () => {
    const md = renderMarkdown(
      artifact([translateCall(MODEL_A, '甲'), translateCall(MODEL_B, '乙')], {
        cases: [{ id: 'q1', question: QUESTION, doc_count: 1 }],
      }),
    )

    expect(md).toContain(`### q1: ${QUESTION}`)
  })

  it('does not blame the response shape for a call that never returned', () => {
    const timedOut: CallResult = {
      ...translateCall(MODEL_A, ''),
      response: null,
      provenance: undefined,
      error: 'timeout after 120000ms',
    }
    const md = renderMarkdown(artifact([timedOut, translateCall(MODEL_B, 'b')]))

    expect(md).not.toContain('nothing to show')
    expect(lineWith(md, `**${MODEL_A}**`)).toContain('timeout after 120000ms')
  })
})

/* ---------------- the acceptance numbers ---------------- */

const artifactOf = (calls: CallResult[]): SweepArtifact => ({
  label: 't',
  target: 'https://qa.example',
  models: [MODEL_A, MODEL_B],
  code_version: null,
  max_results: 40,
  submodule_commit: 'abc',
  calls,
})

const withUsage = (call: CallResult, usage: unknown): CallResult => ({
  ...call,
  response: { ...(call.response as object), usage },
})

describe('summarise — the bar’s two numbers', () => {
  it('reports p95 with the sample count beside it', () => {
    const calls = [100, 200, 300, 400, 500].map((ms, i) =>
      whyCall(MODEL_A, ['a'], { case_id: `q${i}`, latency_ms: ms }),
    )
    const [row] = summarise(artifactOf(calls))
    expect(row.calls).toBe(5)
    expect(row.p95Ms).toBe(500)
    expect(renderMarkdown(artifactOf(calls))).toContain('p95 500 ms (n=5)')
  })

  it('counts a failed call through checkCall, substitutions included', () => {
    const calls = [
      whyCall(MODEL_A, ['a']),
      whyCall(MODEL_A, ['b'], {
        case_id: 'q2',
        response: {
          ok: true,
          explanations: [{ why: 'b' }],
          provenance: { model: MODEL_A, produced: true, sanitized: true },
        },
        provenance: { model: MODEL_A, produced: true, sanitized: true },
      }),
    ]
    expect(summarise(artifactOf(calls))[0].failed).toBe(1)
  })

  it('leaves cost null when a route reports no usage, rather than zero', () => {
    const [row] = summarise(artifactOf([translateCall(MODEL_A, 'hello')]))
    expect(row.costUsd).toBeNull()
  })

  it('leaves cost unmeasured when only some calls report usage', () => {
    const calls = [
      withUsage(whyCall(MODEL_A, ['a']), {
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
      }),
      whyCall(MODEL_A, ['b'], { case_id: 'q2' }),
    ]
    expect(summarise(artifactOf(calls))[0].costUsd).toBeNull()
    expect(renderMarkdown(artifactOf(calls))).toContain('cost unmeasured')
  })

  it.each([
    undefined,
    { prompt_tokens: 100 },
    { prompt_tokens: -1, completion_tokens: 20 },
    { prompt_tokens: 'invalid', completion_tokens: 20 },
  ])(
    'leaves cost unmeasured for an alignment attempt with incomplete usage %j',
    (usage) => {
      const call = alignmentCall(MODEL_A, ['x'], {
        response: {
          debug: {
            tries: [
              { usage },
              { usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } },
            ],
          },
        },
      })
      expect(summarise(artifactOf([call]))[0].costUsd).toBeNull()
    },
  )

  it('prices complete input/output token usage without prompt/completion aliases', () => {
    const call = withUsage(whyCall(MODEL_A, ['a']), {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    })
    expect(summarise(artifactOf([call]))[0].costUsd).toBe(1.45)
  })

  it('prices by the model asked for, not the id the response echoes', () => {
    const call = withUsage(whyCall(MODEL_A, ['a']), {
      model: 'openai/gpt-6.1-terra', // alignment's prefix, and a different model
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
    })
    // gpt-5.4-nano is the requested id; a lookup on usage.model would price terra.
    const price = MODELS[MODEL_A].price!
    expect(summarise(artifactOf([call]))[0].costUsd).toBeCloseTo(
      price.inputPer1M,
      6,
    )
  })

  it('sums every alignment attempt, not only the one that parsed', () => {
    const call: CallResult = {
      route: 'alignment',
      case_id: 'q1',
      model: MODEL_A,
      request: { query: QUESTION, resultsSummary: 's' },
      response: {
        ok: true,
        assessment: { insights: ['x'] },
        debug: {
          tries: [
            { usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } },
            { usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } },
          ],
        },
        provenance: { model: MODEL_A, produced: true },
      },
      provenance: { model: MODEL_A, produced: true },
      latency_ms: 900,
    }
    const price = MODELS[MODEL_A].price!
    expect(summarise(artifactOf([call]))[0].costUsd).toBeCloseTo(
      2 * price.inputPer1M,
      6,
    )
  })
})

describe('acceptanceGate — a clean mechanical run is not a passed bar', () => {
  // Two REGISTERED and priced models: an unregistered one has no price, so its
  // cost is unmeasured and the delta clause never runs.
  const NANO = 'gpt-5.4-nano'
  const MINI = 'gpt-5.4-mini'
  const priced = (model: string, inputTokens: number) =>
    withUsage(whyCall(model, ['a', 'b']), {
      prompt_tokens: inputTokens,
      completion_tokens: 0,
    })
  const pair = (calls: CallResult[], models: [string, string]) => ({
    ...artifactOf(calls),
    models,
  })

  it('fails when a route reported no usage, so its cost is unmeasured', () => {
    const gate = acceptanceGate(
      pair([translateCall(NANO, 'a'), translateCall(MINI, 'b')], [NANO, MINI]),
    )
    expect(gate.ok).toBe(false)
    expect(gate.reasons.join(' ')).toMatch(/cost unmeasured/i)
  })

  it('fails when a candidate costs more than 20% above the incumbent', () => {
    // nano is $0.20/1M input, mini $0.75: 1M vs 3M input is +1025%.
    const gate = acceptanceGate(
      pair([priced(NANO, 1_000_000), priced(MINI, 3_000_000)], [NANO, MINI]),
    )
    expect(gate.ok).toBe(false)
    expect(gate.reasons.join(' ')).toMatch(/\+1025\.0% vs .*allows ±20%/i)
  })

  it('fails when a route ran one model but not the other', () => {
    // roborev job 931: summarise() skips a pair with no calls, so a candidate that
    // never ran on a route the incumbent ran was silently not compared.
    const gate = acceptanceGate(
      pair([priced(NANO, 1_000_000), translateCall(MINI, 'b')], [NANO, MINI]),
    )
    expect(gate.ok).toBe(false)
    expect(gate.reasons.join(' ')).toMatch(
      /no calls for batch-why \/ gpt-5\.4-mini/i,
    )
  })

  it('fails when the incumbent cost is zero, so the bar cannot be computed', () => {
    // roborev job 932: a zero baseline used to skip the clause entirely and let
    // any candidate through. "Within 20% of the incumbent's" is unanswerable at 0.
    const zero = withUsage(whyCall(NANO, ['a', 'b']), {
      prompt_tokens: 0,
      completion_tokens: 0,
    })
    const gate = acceptanceGate(
      pair([zero, priced(MINI, 1_000_000)], [NANO, MINI]),
    )
    expect(gate.ok).toBe(false)
    expect(gate.reasons.join(' ')).toMatch(/incumbent cost is zero/i)
  })

  it('passes when every row is priced and the pair is within 20%', () => {
    // nano $0.20/1M x 1.0M vs gpt-4o-mini $0.15/1M x 1.3M: 0.200 vs 0.195.
    const gate = acceptanceGate(
      pair(
        [priced(NANO, 1_000_000), priced('gpt-4o-mini', 1_300_000)],
        [NANO, 'gpt-4o-mini'],
      ),
    )
    expect(gate).toMatchObject({ ok: true, reasons: [] })
  })
})
