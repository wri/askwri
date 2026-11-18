/** @jest-environment node */
import { ASSIGNMENT, MODELS, type ModelId } from '@/config/models'

/**
 * The registry's contract: every incumbent code default is a known model,
 * each task is assigned its CURRENT CODE DEFAULT (not the deployed value —
 * production overrides through OPENAI_MODEL*, and that precedence is
 * untouched this stage), and the four GPT-6 candidates are known but not
 * assigned. Capability is recorded, not used: only supportsEffortNone is
 * asserted here, and no price is asserted this stage.
 */
describe('model registry', () => {
  it('every assigned task names a known model', () => {
    const known = Object.keys(MODELS)
    for (const model of Object.values(ASSIGNMENT)) {
      expect(known).toContain(model)
    }
  })

  it('registers every incumbent code default as a known model', () => {
    ;['gpt-4o-mini', 'gpt-5-mini', 'gpt-5.4', 'gpt-5.4-nano'].forEach((id) =>
      expect(Object.keys(MODELS)).toContain(id),
    )
  })

  it('assigns each task its current code default', () => {
    expect(ASSIGNMENT).toEqual({
      answer: 'gpt-5.4',
      prefilter: 'gpt-5.4-nano',
      why: 'gpt-4o-mini',
      relates: 'gpt-4o-mini',
      // The alignment route's env chain bottoms out at src/config/alignment's
      // gpt-4o-mini; its 'gpt-5-mini' tail is unreachable with no env set.
      alignment: 'gpt-4o-mini',
      translate: 'gpt-5-mini',
    })
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
