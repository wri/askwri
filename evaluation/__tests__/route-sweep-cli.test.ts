/** @jest-environment node */
import { evalsetPath, frozenSetPath, parseSweepArgs } from '../run-route-sweep'

const MODELS = ['--model-a', 'gpt-5.4-nano', '--model-b', 'gpt-5.6-luna']
const TOKEN = ['--token', 'eval-token']

/** A command line satisfying everything a sweep requires, so a test varies
 * exactly one thing from a run that would work. */
const argv = (...extra: string[]): string[] => [
  '--label',
  'smoke',
  ...MODELS,
  ...TOKEN,
  ...extra,
]

const labels = (...extra: string[]): string[] => ['--label', 'smoke', ...extra]

beforeEach(() => {
  delete process.env.EVAL_MODEL_OVERRIDE_TOKEN
})

afterAll(() => {
  delete process.env.EVAL_MODEL_OVERRIDE_TOKEN
})

describe('parseSweepArgs', () => {
  it('defaults stage to all, limit 10, concurrency 2, timeout 120000, target qa', () => {
    expect(parseSweepArgs(argv())).toEqual({
      stage: 'all',
      label: 'smoke',
      evalset: 'evalset_answer_02.json',
      limit: 10,
      models: ['gpt-5.4-nano', 'gpt-5.6-luna'],
      target: 'https://qa.askwri-app.org',
      concurrency: 2,
      timeoutMs: 120_000,
      token: 'eval-token',
    })
  })

  it('reads every overridable flag', () => {
    const opts = parseSweepArgs(
      argv(
        '--stage',
        'sweep',
        '--evalset',
        'evalset_cite_02.json',
        '--limit',
        '3',
        '--concurrency',
        '1',
        // The ALB idle_timeout itself is the largest allowed deadline.
        '--timeout-ms',
        '300000',
        '--target',
        'https://sweep.example/',
      ),
    )

    expect(opts.stage).toBe('sweep')
    expect(opts.evalset).toBe('evalset_cite_02.json')
    expect(opts.limit).toBe(3)
    expect(opts.concurrency).toBe(1)
    expect(opts.timeoutMs).toBe(300_000)
    // Trailing slashes would otherwise double up in every URL built from it.
    expect(opts.target).toBe('https://sweep.example')
  })

  it('rejects an unknown stage', () => {
    expect(() => parseSweepArgs(argv('--stage', 'both'))).toThrow(/--stage/)
  })

  it('requires two distinct models', () => {
    expect(() =>
      parseSweepArgs([
        ...labels(),
        '--model-a',
        'gpt-5.4-nano',
        '--model-b',
        'gpt-5.4-nano',
        ...TOKEN,
      ]),
    ).toThrow(/never compares a model with itself/)
  })

  it('requires both models to be supplied', () => {
    expect(() =>
      parseSweepArgs([...labels(), '--model-a', 'gpt-5.4-nano', ...TOKEN]),
    ).toThrow(/--model-b/)

    expect(() =>
      parseSweepArgs([...labels(), '--model-b', 'gpt-5.6-luna', ...TOKEN]),
    ).toThrow(/--model-a/)
  })

  it('rejects a timeout above 300000 as beyond the ALB idle_timeout', () => {
    expect(() => parseSweepArgs(argv('--timeout-ms', '300001'))).toThrow(
      /300000[\s\S]*idle_timeout/,
    )
  })

  it('reads the token from --token or EVAL_MODEL_OVERRIDE_TOKEN', () => {
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'from-env'
    expect(parseSweepArgs(labels(...MODELS)).token).toBe('from-env')

    expect(
      parseSweepArgs([...labels(...MODELS), '--token', 'from-flag']).token,
    ).toBe('from-flag')
  })

  it('fails naming both token sources when neither is present', () => {
    expect(() => parseSweepArgs(labels(...MODELS))).toThrow(
      /--token[\s\S]*EVAL_MODEL_OVERRIDE_TOKEN/,
    )
  })

  it('does not require a token to freeze, which makes no override call', () => {
    expect(
      parseSweepArgs([
        ...labels('--model-a', 'a', '--model-b', 'b'),
        '--stage',
        'freeze',
      ]).token,
    ).toBeUndefined()
  })

  it('requires a label, and one that can be a filename', () => {
    expect(() => parseSweepArgs([...MODELS, ...TOKEN])).toThrow(/--label/)

    expect(() =>
      parseSweepArgs(['--label', 'a/b', ...MODELS, ...TOKEN]),
    ).toThrow(/--label/)
  })

  it('rejects numeric flags that are not positive integers', () => {
    expect(() => parseSweepArgs(argv('--limit', '0'))).toThrow(/--limit/)
    expect(() => parseSweepArgs(argv('--concurrency', 'two'))).toThrow(
      /--concurrency/,
    )
  })

  it('rejects a flag with no value', () => {
    expect(() => parseSweepArgs(argv('--limit'))).toThrow(/--limit/)
  })
})

describe('evalsetPath', () => {
  it('resolves a bare name inside the pinned submodule, adding .json', () => {
    expect(evalsetPath('evalset_answer_02.json')).toBe(
      'evaluation/eval-review/evalsets/evalset_answer_02.json',
    )
    expect(evalsetPath('evalset_cite_02')).toBe(
      'evaluation/eval-review/evalsets/evalset_cite_02.json',
    )
  })

  it('takes a path as given, so a temporary set can be run', () => {
    expect(evalsetPath('/tmp/scratch/set.json')).toBe('/tmp/scratch/set.json')
  })
})

describe('frozenSetPath', () => {
  it('names the frozen set per label in the gitignored results dir', () => {
    expect(frozenSetPath('smoke')).toBe(
      'evaluation/results/route-freeze-smoke.json',
    )
  })
})
