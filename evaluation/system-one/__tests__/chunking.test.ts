/**
 * @jest-environment node
 *
 * node, not the repo's default jsdom: the chunking code uses
 * `AbortSignal.timeout`, which jsdom does not implement.
 */

/**
 * Covers request chunking in systemOneNoul — the change that makes a
 * full-vocabulary run possible (757 tags against servers that accept 32, 60 or
 * 255 questions). Its failure modes are silent: mismatched question keys or a
 * lost batch would still produce a plausible-looking score map.
 */
import { systemOneNoul, type Candidate } from '../systems'

const candidate = (label: string): Candidate => ({
  label,
  description: null,
  aliases: [],
  distance: 0.25,
})

/** Answers every question it is given, with a deterministic probability. */
function respond(body: { questions: Record<string, unknown> }, offset = 0) {
  const answers: Record<string, { type: string; noul: number }> = {}
  Object.keys(body.questions).forEach((k, i) => {
    answers[k] = { type: 'noul', noul: (offset + i + 1) / 1000 }
  })
  return { ok: true, json: async () => ({ answers }) }
}

describe('systemOneNoul chunking', () => {
  const realFetch = global.fetch
  const realKey = process.env.SYSTEMONE_API_KEY
  let bodies: Array<{ questions: Record<string, { instructions: string }> }>

  beforeEach(() => {
    bodies = []
    process.env.SYSTEMONE_API_KEY = 'test-key'
  })

  afterEach(() => {
    global.fetch = realFetch
    if (realKey === undefined) delete process.env.SYSTEMONE_API_KEY
    else process.env.SYSTEMONE_API_KEY = realKey
  })

  it('splits 757 candidates into 255-question batches and merges every score', async () => {
    global.fetch = jest.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body)
      bodies.push(body)
      return respond(body, bodies.length * 100) as unknown as Response
    }) as unknown as typeof fetch

    const candidates = Array.from({ length: 757 }, (_, i) => candidate(`tag-${i}`))
    const result = await systemOneNoul('m', { maxQuestions: 255, apiKey: 'k' }).apply('state', candidates)

    expect(bodies.length).toBe(3)
    expect(bodies.map((b) => Object.keys(b.questions).length)).toEqual([255, 255, 247])
    expect(result.error).toBeUndefined()
    expect(Object.keys(result.scores).length).toBe(757)
    expect(result.scores['tag-0']).toBeCloseTo(0.101)
    // batch 3 carries offset 300, so its 247th answer is (300 + 246 + 1)/1000
    expect(result.scores['tag-756']).toBeCloseTo(0.547)
  })

  it('restarts question keys at t0 in every batch so answers map to the right tags', async () => {
    global.fetch = jest.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body)
      bodies.push(body)
      return respond(body) as unknown as Response
    }) as unknown as typeof fetch

    const candidates = Array.from({ length: 300 }, (_, i) => candidate(`tag-${i}`))
    const result = await systemOneNoul('m', { maxQuestions: 255, apiKey: 'k' }).apply('state', candidates)

    expect(bodies.length).toBe(2)
    for (const b of bodies) {
      const keys = Object.keys(b.questions)
      expect(keys[0]).toBe('t0')
      expect(keys[1]).toBe('t1')
    }
    // second batch opens with candidate 255, not a repeated t0 answer
    expect(bodies[1].questions['t0'].instructions).toContain('tag-255')
    expect(result.scores['tag-255']).toBeCloseTo(0.001)
  })

  it('returns no scores at all when a later batch fails', async () => {
    let n = 0
    global.fetch = jest.fn(async (_url: string, init: { body: string }) => {
      n++
      const body = JSON.parse(init.body)
      if (n === 2) return { ok: false, status: 500, text: async () => 'boom' } as unknown as Response
      return respond(body) as unknown as Response
    }) as unknown as typeof fetch

    const candidates = Array.from({ length: 600 }, (_, i) => candidate(`tag-${i}`))
    const result = await systemOneNoul('m', { maxQuestions: 255, apiKey: 'k' }).apply('state', candidates)

    // A partial map would enter the agreement statistics as a real answer.
    expect(result.error).toMatch(/HTTP 500/)
    expect(Object.keys(result.scores).length).toBe(0)
  })

  it('fails loudly when the server answers fewer questions than asked', async () => {
    global.fetch = jest.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body)
      const answers: Record<string, unknown> = {}
      Object.keys(body.questions).forEach(() => {})
      answers['t0'] = { type: 'noul', noul: 0.5 }
      return { ok: true, json: async () => ({ answers }) } as unknown as Response
    }) as unknown as typeof fetch

    const candidates = Array.from({ length: 5 }, (_, i) => candidate(`tag-${i}`))
    const result = await systemOneNoul('m', { maxQuestions: 255, apiKey: 'k' }).apply('state', candidates)

    expect(result.error).toMatch(/only 1\/5 answered/)
  })
})
