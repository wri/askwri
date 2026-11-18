/** @jest-environment node */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ASSIGNMENT, MODELS, resolveModel, type ModelId } from '@/config/models'
import { requestProfile } from '@/lib/request-profile'

/**
 * The registry's contract: every assigned task names a known, priced model — and
 * the assignment is the model QA actually runs, measured once through the deployed
 * routes (`handoffs/2026-11-18-qa-baseline-models.md`) rather than read off the code.
 * A lever (`MODEL_<TASK>`) may point at any registered id and fails loudly when it
 * does not.
 */
describe('model registry', () => {
  it('every assigned task names a known model', () => {
    const known = Object.keys(MODELS)
    for (const model of Object.values(ASSIGNMENT)) {
      expect(known).toContain(model)
    }
  })

  it('registers every incumbent code default as a known model', () => {
    ;[
      'gpt-4o-mini',
      'gpt-5-mini',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
    ].forEach((id) => expect(Object.keys(MODELS)).toContain(id))
  })

  it('assigns each task the model QA actually runs', () => {
    // Measured 2026-11-18 on image 6ad67fc, one unoverridden request per route.
    // A flip edits one row here and its route's line in ASSIGNMENT, together.
    expect(ASSIGNMENT).toEqual({
      answer: 'gpt-5.4-mini',
      prefilter: 'gpt-5.4-nano', // unobservable while USE_NANO_FILTER is off
      why: 'gpt-5.4-nano',
      relates: 'gpt-5.4-nano',
      alignment: 'gpt-5.4-nano',
      translate: 'gpt-5.4-mini',
    })
  })

  it('resolves a task from its lever', () => {
    process.env.MODEL_WHY = 'gpt-6-luna'
    try {
      expect(resolveModel('why')).toBe('gpt-6-luna')
    } finally {
      delete process.env.MODEL_WHY
    }
  })

  it('falls back to the assignment when no lever is set', () => {
    delete process.env.MODEL_TRANSLATE
    expect(resolveModel('translate')).toBe(ASSIGNMENT.translate)
  })

  it('throws on a lever naming an id the registry does not describe', () => {
    process.env.MODEL_WHY = 'gpt-4-turbo'
    try {
      expect(() => resolveModel('why')).toThrow(/unknown model gpt-4-turbo/)
    } finally {
      delete process.env.MODEL_WHY
    }
  })

  it('rejects a known lever model that cannot run the task effort at module load', async () => {
    process.env.MODEL_TRANSLATE = 'gpt-6.1-sol'
    try {
      await expect(
        jest.isolateModulesAsync(async () => {
          await import('@/app/api/translate/route')
        }),
      ).rejects.toThrow(/gpt-6\.1-sol.*none.*translate/i)
    } finally {
      delete process.env.MODEL_TRANSLATE
    }
  })

  it('fails at module load when a route is imported with a bad lever', async () => {
    process.env.MODEL_RELATES = 'gpt-4-turbo'
    try {
      await expect(
        jest.isolateModulesAsync(async () => {
          await import('@/app/api/batch-relates/route')
        }),
      ).rejects.toThrow(/unknown model gpt-4-turbo/)
    } finally {
      delete process.env.MODEL_RELATES
    }
  })

  it('no source file reads an OPENAI_MODEL* variable', () => {
    // The read, not the mention: comments may explain what those keys were.
    // Assembled so this test does not match its own source.
    const pattern = new RegExp('process\\.env\\.OPENAI' + '_MODEL')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry)
        if (statSync(p).isDirectory()) {
          if (entry !== '__tests__') walk(p)
        } else if (/\.(ts|tsx)$/.test(entry)) files.push(p)
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(files.filter((f) => pattern.test(readFileSync(f, 'utf8')))).toEqual(
      [],
    )
  })

  it('prices every model a task is assigned to', () => {
    // The cost half of the acceptance bar is arithmetic on this table. A missing
    // price must fail here, not print a substituted rate in the readout.
    for (const [task, id] of Object.entries(ASSIGNMENT)) {
      expect({ task, priced: Boolean(MODELS[id].price) }).toEqual({
        task,
        priced: true,
      })
    }
  })

  it('declares the candidates as known but unassigned', () => {
    const assigned = new Set(Object.values(ASSIGNMENT))
    ;['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'].forEach(
      (id) => {
        expect(Object.keys(MODELS)).toContain(id)
        expect(assigned.has(id as ModelId)).toBe(false)
      },
    )
  })

  it('records capability without asserting it is used', () => {
    for (const spec of Object.values(MODELS)) {
      expect(typeof spec.capability.gpt5Class).toBe('boolean')
      expect(typeof spec.capability.acceptsMaxCompletionTokens).toBe('boolean')
      expect(typeof spec.capability.supportsEffortNone).toBe('boolean')
    }
    // supportsEffortNone only (design §1: false for astra and 6.1-sol, true
    // for terra, luna and the gpt-5 incumbents).
    expect(MODELS['gpt-6-astra'].capability.supportsEffortNone).toBe(false)
    expect(MODELS['gpt-6.1-sol'].capability.supportsEffortNone).toBe(false)
    expect(MODELS['gpt-6.1-terra'].capability.supportsEffortNone).toBe(true)
    expect(MODELS['gpt-6-luna'].capability.supportsEffortNone).toBe(true)
    expect(MODELS['gpt-5-mini'].capability.supportsEffortNone).toBe(true)
    // acceptsMaxCompletionTokens is a provider fact, and the probe is the evidence:
    // it sends max_completion_tokens at the task's effort and every GPT-6 case came
    // back accepted and usable. Claiming false here sent max_tokens to a family that
    // rejects it, which is how a candidate sweep reads as a capability failure.
    for (const id of [
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6.1-terra',
      'gpt-6-luna',
    ] as const) {
      expect(MODELS[id].capability.acceptsMaxCompletionTokens).toBe(true)
    }
  })
})

describe('the reasoning arm (design §3)', () => {
  const profile = (task: any, model: string) =>
    requestProfile({ task, model, attempt: 'primary', input: {} })

  it('sends max_completion_tokens at the task effort, and no temperature', () => {
    expect(profile('translate', 'gpt-6-luna')).toEqual({
      maxCompletionTokens: 2000,
      reasoningEffort: 'none',
    })
  })

  it('takes the effort the design maps to the task, not one the caller picks', () => {
    expect(profile('alignment', 'gpt-6.1-terra')).toMatchObject({
      maxCompletionTokens: 4000,
      reasoningEffort: 'medium',
    })
    expect(profile('why', 'gpt-6-luna')).toMatchObject({
      reasoningEffort: 'none',
    })
  })

  it('keeps the answer evidence budget for a candidate, never the smaller arm', () => {
    // The failure this exists to prevent: a GPT-6 id matching no family branch
    // and inheriting 6 passages x 350 chars — a sixth of the evidence.
    expect(profile('answer', 'gpt-6.1-sol')).toEqual({
      maxCompletionTokens: 2000,
      maxPassages: 15,
      passageChars: 800,
      reasoningEffort: 'medium',
    })
  })

  it('adds no effort field for an incumbent', () => {
    expect(profile('translate', 'gpt-5.4-mini')).toEqual({
      maxCompletionTokens: 2000,
    })
  })

  it.each([
    [28, 2440],
    [29, 2520],
    [35, 3000],
    [40, 3000],
  ])(
    'keeps the task why budget for %i candidate passages',
    (passages, budget) => {
      expect(
        requestProfile({
          task: 'why',
          model: 'gpt-6-luna',
          attempt: 'primary',
          input: { passages },
        }),
      ).toEqual({ maxCompletionTokens: budget, reasoningEffort: 'none' })
    },
  )
})
