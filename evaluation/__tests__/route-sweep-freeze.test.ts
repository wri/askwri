/** @jest-environment node */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { freezeCases, loadEvalset } from '../route-sweep/freeze'

const TARGET = 'https://qa.askwrimvp.test'
const PINNED_EVALSET = join(
  __dirname,
  '..',
  'evalsets',
  'evalset_answer_02.json',
)

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
  evalsetPath: writeEvalset([caseOf('q1')]),
  ...overrides,
})

let tempDir: string
let tempIndex = 0

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'route-sweep-freeze-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  jest.clearAllMocks()
})

/** Writes an evalset fixture in the vendored fixture shape to the temp dir. */
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

  it('records max_results and the fixture digest in the set', async () => {
    const { fetchImpl } = fetchReturning([{ docs: [] }])
    const evalsetPath = writeEvalset([caseOf('q1')])

    const set = await freezeCases(
      freezeArgs({ maxResults: 40, fetchImpl, evalsetPath }),
    )

    expect(set.max_results).toBe(40)
    expect(set.fixture_sha256).toBe(
      createHash('sha256').update(readFileSync(evalsetPath)).digest('hex'),
    )
    expect(set.label).toBe('smoke')
    expect(set.evalset).toBe('evalset_answer_02.json')
    expect(set.target).toBe(TARGET)
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
  it('loads the first N cases of a named evalset', () => {
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
        evalsetNote: 'no expert_approved cases in the fixture',
      }),
    )
    expect(set.evalsetNote).toBe('no expert_approved cases in the fixture')
  })

  it('names the missing evalset when the file is absent', () => {
    expect(() => loadEvalset(join(tempDir, 'missing.json'), {})).toThrow(
      /evalset not found/,
    )
  })
})
