/** @jest-environment node */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The submodule commit comes from git; mocking child_process keeps the suite
// off the real repo state and pins what the frozen set records.
jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }))

import { execFileSync } from 'node:child_process'
import { freezeCases, loadEvalset } from '../route-sweep/freeze'

const SUBMODULE_COMMIT = '1dcbeabc909073c4141e8088cce8b7fef6de243a'
const TARGET = 'https://qa.askwrimvp.test'
const PINNED_EVALSET = join(
  __dirname,
  '..',
  'eval-review',
  'evalsets',
  'evalset_answer_02.json',
)

// pr-check's checkout does not initialise submodules, so the assertions against
// the pinned file self-skip there instead of failing on a missing fixture.
const pinnedSetTest = existsSync(PINNED_EVALSET) ? it : it.skip

const caseOf = (id: string) => ({
  id,
  question: `question for ${id}`,
  source_language: 'zh',
})

type FetchCall = { url: string; init: RequestInit }

function fetchReturning(bodies: unknown[]): {
  fetchImpl: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  let index = 0
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init })
    const body = bodies[Math.min(index, bodies.length - 1)]
    index += 1
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(''),
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const freezeArgs = (overrides: Record<string, unknown> = {}) => ({
  cases: [caseOf('q1')],
  target: TARGET,
  maxResults: 40,
  label: 'smoke',
  evalset: 'evalset_answer_02.json',
  ...overrides,
})

let tempDir: string
let tempIndex = 0

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'route-sweep-freeze-'))
  ;(execFileSync as unknown as jest.Mock).mockReturnValue(
    `${SUBMODULE_COMMIT}\n`,
  )
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  jest.clearAllMocks()
})

/** Writes an evalset fixture in the submodule's shape to the temp dir. */
function writeEvalset(cases: Record<string, unknown>[]): string {
  tempIndex += 1
  const path = join(tempDir, `evalset-${tempIndex}.json`)
  writeFileSync(
    path,
    JSON.stringify({ name: `temp-${tempIndex}`, test_cases: cases }),
  )
  return path
}

describe('freezeCases', () => {
  it('posts {query, mode: "cite", max_results} to /api/llamaindex on the target', async () => {
    const { fetchImpl, calls } = fetchReturning([{ docs: [] }, { docs: [] }])

    await freezeCases(
      freezeArgs({
        cases: [caseOf('q1'), caseOf('q2')],
        maxResults: 40,
        fetchImpl,
      }),
    )

    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe(`${TARGET}/api/llamaindex`)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers).toEqual({
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      query: 'question for q1',
      mode: 'cite',
      max_results: 40,
    })
    expect(JSON.parse(String(calls[1].init.body)).query).toBe('question for q2')
  })

  it('records docs and doc_count per case', async () => {
    const docsA = [{ doc_id: 'a', content: 'A' }]
    const docsB = [
      { doc_id: 'b', content: 'B' },
      { doc_id: 'c', content: 'C' },
    ]
    const { fetchImpl } = fetchReturning([{ docs: docsA }, { docs: docsB }])

    const set = await freezeCases(
      freezeArgs({ cases: [caseOf('q1'), caseOf('q2')], fetchImpl }),
    )

    expect(set.cases).toHaveLength(2)
    expect(set.cases[0]).toEqual({
      ...caseOf('q1'),
      docs: docsA,
      doc_count: 1,
    })
    expect(set.cases[1].docs).toEqual(docsB)
    expect(set.cases[1].doc_count).toBe(2)
  })

  it('records max_results and the submodule commit in the set', async () => {
    const { fetchImpl } = fetchReturning([{ docs: [] }])

    const set = await freezeCases(freezeArgs({ maxResults: 40, fetchImpl }))

    expect(set.max_results).toBe(40)
    expect(set.submodule_commit).toBe(SUBMODULE_COMMIT)
    expect(set.label).toBe('smoke')
    expect(set.evalset).toBe('evalset_answer_02.json')
    expect(set.target).toBe(TARGET)
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', 'evaluation/eval-review', 'rev-parse', 'HEAD'],
      expect.anything(),
    )
    // No reviewed tier was passed, so there is nothing to say about one.
    expect('evalsetNote' in set).toBe(false)
  })

  it('records doc_count 0 without throwing when a case returns no docs', async () => {
    const { fetchImpl } = fetchReturning([{ docs: [] }])

    const set = await freezeCases(freezeArgs({ fetchImpl }))

    expect(set.cases[0].docs).toEqual([])
    expect(set.cases[0].doc_count).toBe(0)
  })

  it('throws when a retrieval fails rather than recording zero docs', async () => {
    const fetchImpl = (() =>
      Promise.resolve({
        ok: false,
        status: 502,
        text: () => Promise.resolve('upstream down'),
        json: () => Promise.resolve({}),
      })) as unknown as typeof fetch

    await expect(
      freezeCases(freezeArgs({ fetchImpl, cases: [caseOf('q1')] })),
    ).rejects.toThrow(/q1.*502.*upstream down/s)
  })
})

describe('loadEvalset', () => {
  pinnedSetTest('loads the first N cases of a named evalset', () => {
    const loaded = loadEvalset(PINNED_EVALSET, { limit: 2 })

    expect(loaded.cases).toHaveLength(2)
    expect(loaded.cases[0].id).toBe('q1_zero-emission-heavy-duty-trucks')
    expect(loaded.cases[0].source_language).toBe('zh')
    // No case at the current pin carries review_status, so nothing was filtered.
    expect(loaded.expert_approved_only).toBe(false)
  })

  it('loads exactly the requested ids and errors on an unknown id', () => {
    const path = writeEvalset([caseOf('a'), caseOf('b'), caseOf('c')])

    const loaded = loadEvalset(path, { ids: ['b', 'c'] })
    expect(loaded.cases.map((c) => c.id)).toEqual(['b', 'c'])

    expect(() => loadEvalset(path, { ids: ['b', 'zzz'] })).toThrow(
      /unknown case id\(s\).*zzz/,
    )
  })

  it('prefers expert_approved cases when the set has any', () => {
    const path = writeEvalset([
      caseOf('a'),
      { ...caseOf('b'), review_status: 'expert_approved' },
      { ...caseOf('c'), review_status: 'expert_approved' },
    ])

    const loaded = loadEvalset(path, { limit: 10 })

    expect(loaded.cases.map((c) => c.id)).toEqual(['b', 'c'])
    expect(loaded.expert_approved_only).toBe(true)
    expect(loaded.cases[0]).toEqual(caseOf('b'))
  })

  it('reports no reviewed tier when no case is expert_approved', async () => {
    const path = writeEvalset([caseOf('a'), caseOf('b')])

    const loaded = loadEvalset(path, { limit: 1 })
    expect(loaded.expert_approved_only).toBe(false)
    expect(loaded.cases.map((c) => c.id)).toEqual(['a'])

    const { fetchImpl } = fetchReturning([{ docs: [] }])
    const set = await freezeCases(
      freezeArgs({
        cases: loaded.cases,
        fetchImpl,
        evalsetNote: `no expert_approved cases at pin ${SUBMODULE_COMMIT}`,
      }),
    )
    expect(set.evalsetNote).toBe(
      `no expert_approved cases at pin ${SUBMODULE_COMMIT}`,
    )
  })

  it('names the submodule init command when the evalset file is absent', () => {
    expect(() => loadEvalset(join(tempDir, 'missing.json'), {})).toThrow(
      /git submodule update --init evaluation\/eval-review/,
    )
  })
})
