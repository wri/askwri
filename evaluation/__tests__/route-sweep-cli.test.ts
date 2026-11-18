/** @jest-environment node */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  evalsetPath,
  freezeNote,
  frozenSetPath,
  frozenTargetWarning,
  parseSweepArgs,
  selectCases,
} from '../run-route-sweep'

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

let tempDir: string

beforeEach(() => {
  delete process.env.EVAL_MODEL_OVERRIDE_TOKEN
  tempDir = mkdtempSync(join(tmpdir(), 'route-sweep-cli-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
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

  it('rejects a flag it does not know instead of falling back to a default', () => {
    // An ignored token takes a default with it, and the default stage refetches
    // and overwrites the frozen set the operator meant to replay.
    expect(() => parseSweepArgs(argv('--limt', '3'))).toThrow(/--limt/)
    expect(() => parseSweepArgs(argv('--stage=sweep'))).toThrow(/--stage=sweep/)
  })

  it('reads --ids as the cases to run', () => {
    expect(parseSweepArgs(argv('--ids', 'q1, q3')).ids).toEqual(['q1', 'q3'])
    expect(parseSweepArgs(argv()).ids).toBeUndefined()
  })

  it('does not cut a named id list down to the default limit', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `q${i}`)

    expect(parseSweepArgs(argv('--ids', ids.join(','))).limit).toBe(12)
    // An explicit --limit still wins over the list length.
    expect(
      parseSweepArgs(argv('--ids', 'q1,q2,q3', '--limit', '1')).limit,
    ).toBe(1)
  })

  it('rejects an --ids value holding no case id', () => {
    expect(() => parseSweepArgs(argv('--ids', ' , '))).toThrow(/--ids/)
  })
})

describe('selectCases', () => {
  const writeEvalset = (ids: string[]): string => {
    const path = join(tempDir, 'set.json')
    writeFileSync(
      path,
      JSON.stringify({
        test_cases: ids.map((id) => ({ id, question: `question for ${id}` })),
      }),
    )
    return path
  }

  it('selects exactly the cases --ids names', () => {
    const set = writeEvalset(['a', 'b', 'c'])

    const loaded = selectCases(
      parseSweepArgs(argv('--evalset', set, '--ids', 'c,a')),
    )

    expect(loaded.cases.map((c) => c.id)).toEqual(['a', 'c'])
  })

  it('fails naming the id the evalset does not have', () => {
    const set = writeEvalset(['a', 'b'])

    expect(() =>
      selectCases(parseSweepArgs(argv('--evalset', set, '--ids', 'a,nope'))),
    ).toThrow(/nope/)
  })

  it('takes the first --limit cases in file order without --ids', () => {
    const set = writeEvalset(['a', 'b', 'c'])

    const loaded = selectCases(
      parseSweepArgs(argv('--evalset', set, '--limit', '2')),
    )

    expect(loaded.cases.map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('freezeNote', () => {
  const loaded = (ids: string[], expert_approved_only = false) => ({
    cases: ids.map((id) => ({ id, question: `question for ${id}` })),
    expert_approved_only,
  })

  it('says the first N in file order were used without --ids', () => {
    expect(freezeNote('set.json', loaded(['a', 'b']))).toBe(
      'no expert_approved case in set.json; the first 2 in file order were used',
    )
  })

  // `--ids c,a` selects [a, c] from [a, b, c]: a prefix claim would be false.
  it('says the cases named by --ids were used when --ids was given', () => {
    expect(freezeNote('set.json', loaded(['a', 'c']), ['c', 'a'])).toBe(
      'no expert_approved case in set.json; the 2 cases named by --ids were used',
    )
    expect(freezeNote('set.json', loaded(['c']), ['c'])).toBe(
      'no expert_approved case in set.json; the 1 case named by --ids was used',
    )
  })

  it('says nothing when the selection was the reviewed tier', () => {
    expect(freezeNote('set.json', loaded(['b'], true), ['b'])).toBeUndefined()
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

describe('frozenTargetWarning', () => {
  it('says nothing when the documents and the sweep name one host', () => {
    // A trailing slash is normalized away by the parser, so neither side may be
    // compared raw.
    expect(
      frozenTargetWarning(
        { target: 'https://qa.askwri-app.org' },
        'https://qa.askwri-app.org/',
      ),
    ).toBeUndefined()
  })

  it('names both hosts when --stage sweep targets another', () => {
    const warning = frozenTargetWarning(
      { target: 'https://qa.askwri-app.org' },
      'https://sweep.example',
    )

    expect(warning).toBeDefined()
    expect(warning).toContain('https://qa.askwri-app.org')
    expect(warning).toContain('https://sweep.example')
  })
})
