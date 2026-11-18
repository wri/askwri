/** @jest-environment node */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ASSIGNMENT,
  EMBEDDERS,
  MODELS,
  resolveModel,
  type ModelId,
} from '@/config/models'
import { requestProfile, wireParams } from '@/lib/request-profile'
import { estimateCostUSD } from '@/config/costs'
import { EST_PER_DOC_COST } from '@/db/queries/topicsAdmin'

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
    // `low`, not the design's `medium`: operator ruling 2026-11-18, latency first.
    // Probed: effort moved alignment latency far less than the model did.
    expect(profile('alignment', 'gpt-6.1-terra')).toMatchObject({
      maxCompletionTokens: 4000,
      reasoningEffort: 'low',
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

  // Fast mode (operator ruling 2026-11-18, latency first): probed on luna and
  // terra, it cut batch-why 30-54% and alignment 18-48%. Only the reasoning arm
  // sends it: the incumbents were never probed with a service_tier.
  it('puts fast mode on the wire for batch-why and alignment candidates', () => {
    for (const [task, model] of [
      ['why', 'gpt-6-luna'],
      ['alignment', 'gpt-6.1-terra'],
    ] as const) {
      expect(wireParams(profile(task, model))).toMatchObject({
        service_tier: 'fast',
      })
    }
  })

  it('leaves fast mode off the tasks it was not asked for', () => {
    for (const task of ['translate', 'relates', 'answer', 'prefilter']) {
      expect(wireParams(profile(task, 'gpt-6-luna'))).not.toHaveProperty(
        'service_tier',
      )
    }
  })

  it('never sends fast mode to an incumbent, whatever the task', () => {
    for (const task of ['why', 'alignment']) {
      expect(wireParams(profile(task, 'gpt-5.4-nano'))).not.toHaveProperty(
        'service_tier',
      )
      expect(wireParams(profile(task, 'gpt-4o-mini'))).not.toHaveProperty(
        'service_tier',
      )
    }
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
      ).toEqual({
        maxCompletionTokens: budget,
        reasoningEffort: 'none',
        serviceTier: 'fast',
      })
    },
  )
})

describe('cost and energy read the registry (Task 4b)', () => {
  it('gives every model a tier', () => {
    for (const [id, spec] of Object.entries(MODELS)) {
      expect({ id, tier: spec.tier }).toMatchObject({
        id,
        tier: expect.stringMatching(/^(flagship|balanced|fast|volume)$/),
      })
    }
  })

  it('prices a registry model at the registry rate', () => {
    expect(
      estimateCostUSD({
        model: 'gpt-6-luna',
        prompt_tokens: 1_000_000,
        completion_tokens: 1_000_000,
      }),
    ).toBeCloseTo(0.6, 6)
  })

  it('accepts the openai/ prefix alignment stamps', () => {
    expect(
      estimateCostUSD({
        model: 'openai/gpt-5.4-nano',
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
      }),
    ).toBeCloseTo(0.2, 6)
  })

  it('throws on an unregistered model rather than pricing gpt-4o-mini', () => {
    expect(() =>
      estimateCostUSD({ model: 'gpt-9-imaginary', prompt_tokens: 10 }),
    ).toThrow(/unknown model gpt-9-imaginary/)
  })

  it('prices the active embedder', () => {
    expect(
      estimateCostUSD({
        model: EMBEDDERS.active,
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
      }),
    ).toBeCloseTo(0.12, 6)
  })

  it('derives the per-document estimate from the worker model, not a literal', () => {
    const price = MODELS['gpt-6-luna'].price!
    expect(EST_PER_DOC_COST).toBeCloseTo(
      (2000 / 1_000_000) * price.inputPer1M +
        (100 / 1_000_000) * price.outputPer1M,
      6,
    )
  })
})

describe('cost lookups that must fail loudly', () => {
  it('throws for a registered model with no sourced price', () => {
    // gpt-5.4 is registered ahead of any assignment to it; selecting it must fail
    // on the first cost computation rather than borrow another model's rate.
    expect(() =>
      estimateCostUSD({ model: 'gpt-5.4', prompt_tokens: 10 }),
    ).toThrow(/no price for gpt-5\.4/)
  })

  it('throws when usage carries no model at all', () => {
    expect(() => estimateCostUSD({ prompt_tokens: 10 })).toThrow(
      /unknown model/,
    )
  })
})
