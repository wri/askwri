/** @jest-environment node */
import { parseControls } from '../cli'

const EVALSET = '/fixtures/dir/my-evalset.json'

describe('parseControls', () => {
  const ENV = { ...process.env }

  afterEach(() => {
    process.env = { ...ENV }
  })

  it('defaults every control', () => {
    delete process.env.EVAL_TARGET
    delete process.env.LUNAROUTE_BASE_URL
    const c = parseControls([EVALSET], 'capture')
    expect(c).toMatchObject({
      only: [],
      limit: undefined,
      passes: 1,
      label: 'my-evalset',
      concurrency: 1,
      targetUrl: 'https://qa.askwri-app.org',
      directSearchUrl: undefined,
      directAnswerUrl: undefined,
      retrievalKnobs: {},
      synthesisKnobs: {},
      skip: [],
      timeoutMs: undefined,
      evalsetPath: EVALSET,
    })
  })

  it('honors the EVAL_TARGET env default', () => {
    process.env.EVAL_TARGET = 'https://prod.example'
    const c = parseControls([EVALSET], 'capture')
    expect(c.targetUrl).toBe('https://prod.example')
  })

  it('parses repeatable --skip and --timeout (ms)', () => {
    const c = parseControls(
      [EVALSET, '--skip', 'q3', '--skip', 'q7', '--timeout', '600000'],
      'capture',
    )
    expect(c.skip).toEqual(['q3', 'q7'])
    expect(c.timeoutMs).toBe(600000)
  })

  it('rejects the judge-stage flags: they belong to run-judge / run-compare', () => {
    expect(() =>
      parseControls([EVALSET, '--judge-model', 'm'], 'capture'),
    ).toThrow(/unknown flag --judge-model/)
    expect(() =>
      parseControls([EVALSET, '--judge-base-url', 'u'], 'capture'),
    ).toThrow(/unknown flag --judge-base-url/)
  })

  it('parses repeatable --only, --limit, --passes, --label, --concurrency, --target', () => {
    const c = parseControls(
      [
        EVALSET,
        '--only',
        'q1',
        '--only',
        'q2',
        '--limit',
        '5',
        '--passes',
        '4',
        '--label',
        'sweep-a',
        '--concurrency',
        '3',
        '--target',
        'https://t.example',
      ],
      'capture',
    )
    expect(c.only).toEqual(['q1', 'q2'])
    expect(c.limit).toBe(5)
    expect(c.passes).toBe(4)
    expect(c.label).toBe('sweep-a')
    expect(c.concurrency).toBe(3)
    expect(c.targetUrl).toBe('https://t.example')
  })

  it('supports --flag=value syntax', () => {
    const c = parseControls([EVALSET, '--passes=2', '--label=x'], 'capture')
    expect(c.passes).toBe(2)
    expect(c.label).toBe('x')
  })

  it('routes the six synthesis knobs to synthesisKnobs with coerced values', () => {
    const c = parseControls(
      [
        EVALSET,
        '--knob',
        'model=gpt-x',
        '--knob',
        'base_url=https://llm.example/v1',
        '--knob',
        'max_passages=12',
        '--knob',
        'passage_chars=800',
        '--knob',
        'prompt_version=v1',
        '--knob',
        'likely_off_topic=true',
      ],
      'capture',
    )
    expect(c.synthesisKnobs).toEqual({
      model: 'gpt-x',
      base_url: 'https://llm.example/v1',
      max_passages: 12,
      passage_chars: 800,
      prompt_version: 'v1',
      likely_off_topic: true,
    })
    expect(c.retrievalKnobs).toEqual({})
  })

  it('routes forwardable /query fields to retrievalKnobs', () => {
    const c = parseControls(
      [
        EVALSET,
        '--knob',
        'dense_weight=0.8',
        '--knob',
        'max_results=30',
        '--knob',
        'cite_doc_ids=x',
      ],
      'capture',
    )
    expect(c.retrievalKnobs).toEqual({
      dense_weight: 0.8,
      max_results: 30,
      cite_doc_ids: 'x',
    })
    expect(c.synthesisKnobs).toEqual({})
  })

  it('hard-errors on an unknown knob', () => {
    expect(() =>
      parseControls([EVALSET, '--knob', 'bogus=1'], 'capture'),
    ).toThrow(/unknown knob.*bogus/)
  })

  it('hard-errors on an unknown flag, a valueless flag, a valueless knob, and a missing evalset path', () => {
    expect(() => parseControls([EVALSET, '--bogus'], 'capture')).toThrow(
      /unknown flag/,
    )
    expect(() => parseControls([EVALSET, '--passes'], 'capture')).toThrow(
      /--passes/,
    )
    expect(() =>
      parseControls([EVALSET, '--knob', 'noequals'], 'capture'),
    ).toThrow(/key=value/)
    expect(() => parseControls([], 'capture')).toThrow(/evalset/)
  })

  it('switches to direct mode when --direct-search is present', () => {
    const c = parseControls(
      [
        EVALSET,
        '--direct-search',
        'http://localhost:8000',
        '--direct-answer',
        'http://localhost:3000',
      ],
      'capture',
    )
    expect(c.directSearchUrl).toBe('http://localhost:8000')
    expect(c.directAnswerUrl).toBe('http://localhost:3000')
  })

  it('rejects a non-positive or non-integer count flag', () => {
    expect(() => parseControls([EVALSET, '--passes', '0'], 'capture')).toThrow(
      /--passes/,
    )
    expect(() =>
      parseControls([EVALSET, '--passes', '1.5'], 'capture'),
    ).toThrow(/--passes/)
  })

  it('rejects --direct-search without --direct-answer, and --direct-answer without --direct-search', () => {
    expect(() =>
      parseControls(
        [EVALSET, '--direct-search', 'http://localhost:8000'],
        'capture',
      ),
    ).toThrow(/--direct-answer/)
    // Symmetric: --direct-answer alone must not silently fall back to
    // gateway mode.
    expect(() =>
      parseControls(
        [EVALSET, '--direct-answer', 'http://localhost:3000'],
        'capture',
      ),
    ).toThrow(/--direct-search/)
  })
})
