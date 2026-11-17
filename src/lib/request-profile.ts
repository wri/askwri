/**
 * One builder for the request parameters every analysis route sends upstream:
 * which token field, which token budget, whether temperature rides along.
 *
 * The budget formulas are MOVED, not invented — each branch reproduces what
 * the route it came from computes today, characterized byte-for-byte by
 * route-requests-unchanged.test.ts. Registered model ids read capability from
 * the registry; ids the registry does not know (eval overrides, route sweeps,
 * the GLM judge) fall back to the family tests that used to live in each
 * caller. This file is the only place a model family is string-matched.
 */
import {
  ALIGNMENT_MAX_TOKENS as CFG_MAX_TOKENS,
  ALIGNMENT_TEMPERATURE as CFG_TEMPERATURE,
} from '@/config/alignment'
import { MODELS, type Effort, type ModelId, type TaskId } from '@/config/models'

export interface RequestProfile {
  /** The max_completion_tokens parameter (gpt-5-class models). */
  maxCompletionTokens?: number
  /** The max_tokens parameter (everything batch-why does not upgrade). */
  maxTokens?: number
  temperature?: number
  /** Declared per task by the registry; undefined — never sent — this stage. */
  reasoningEffort?: Effort
  /** Answer synthesis only: the evidence budget the model class decides. */
  maxPassages?: number
  passageChars?: number
}

/** The profile's wire fields, in the key order today's requests use. */
export function wireParams(p: RequestProfile): Record<string, number> {
  const out: Record<string, number> = {}
  if (p.maxCompletionTokens !== undefined)
    out.max_completion_tokens = p.maxCompletionTokens
  if (p.maxTokens !== undefined) out.max_tokens = p.maxTokens
  if (p.temperature !== undefined) out.temperature = p.temperature
  return out
}

/** The only model-family string tests left in the app tier. */
const GPT5 = /^gpt-5/i

function spec(model: string): (typeof MODELS)[ModelId] | undefined {
  return Object.prototype.hasOwnProperty.call(MODELS, model)
    ? MODELS[model as ModelId]
    : undefined
}

/** Capability of a possibly-unregistered id — registry first. */
export function modelCapability(model: ModelId | string): {
  /** Today's /^gpt-5/i arm: max_completion_tokens, no temperature, the
   *  gpt-5 budget and timeout ladders. */
  gpt5Class: boolean
  /** o1 merges its system prompt into the user message (batch-why only). */
  mergesSystemIntoUser: boolean
} {
  const s = spec(model)
  if (s) {
    return {
      gpt5Class: s.capability.gpt5Class,
      mergesSystemIntoUser: false, // no registered model is o1-class
    }
  }
  return {
    gpt5Class: GPT5.test(model),
    mergesSystemIntoUser: model.includes('o1'),
  }
}

export function requestProfile(args: {
  task: TaskId
  /** A string is allowed: the eval-only callers send unregistered ids. */
  model: ModelId | string
  attempt: 'primary' | 'repair'
  input: {
    passages?: number // why
    documents?: number // relates
  }
}): RequestProfile {
  const { task, model, attempt, input } = args
  switch (task) {
    case 'answer': {
      if (modelCapability(model).gpt5Class) {
        const envMax = Number(process.env.OPENAI_MAX_TOKENS || 2000)
        return {
          maxCompletionTokens: Math.max(2000, envMax),
          maxPassages: 15,
          passageChars: 800,
        }
      }
      return {
        maxTokens: Number(process.env.OPENAI_MAX_TOKENS || 1500),
        temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0.3),
        maxPassages: 6,
        passageChars: 350,
      }
    }
    case 'prefilter':
      // answer/route.ts's nano relevance filter: a fixed 500 either way.
      return modelCapability(model).gpt5Class
        ? { maxCompletionTokens: 500 }
        : { maxTokens: 500, temperature: 0.1 }
    case 'why': {
      const s = spec(model)
      // batch-why sized its GPT-5 budget by substring; every other caller
      // used the prefix test. Registered ids satisfy both.
      const gpt5 = s
        ? s.capability.gpt5Class
        : model.includes('gpt-5') || model === 'gpt-5-mini'
      const budget = Math.min(
        200 + (input.passages ?? 0) * 80,
        gpt5 ? 3000 : 2500,
      )
      if (gpt5) return { maxCompletionTokens: budget }
      if (s) {
        // Registry-known: gpt-4o-class takes max_completion_tokens here.
        return s.capability.acceptsMaxCompletionTokens
          ? { maxCompletionTokens: budget, temperature: 0.3 }
          : { maxTokens: budget, temperature: 0.3 }
      }
      // Unregistered ids keep today's per-caller arms, original order
      // (o1 before gpt-4o): o1 drops the temperature, gpt-4o keeps it.
      if (model.includes('o1')) return { maxCompletionTokens: budget }
      if (model.includes('gpt-4o'))
        return { maxCompletionTokens: budget, temperature: 0.3 }
      return { maxTokens: budget, temperature: 0.3 }
    }
    case 'relates': {
      const documents = input.documents ?? 0
      if (modelCapability(model).gpt5Class) {
        // GPT-5 spends reasoning tokens out of the same budget, so it gets
        // the larger floor.
        return { maxCompletionTokens: Math.max(1000, documents * 120) }
      }
      return {
        maxTokens: Math.min(documents * 120, 4000),
        temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0.2),
      }
    }
    case 'translate':
      // A passage is capped at 800 chars upstream; the translation can run
      // longer, and GPT-5 spends reasoning tokens out of the same budget.
      return modelCapability(model).gpt5Class
        ? { maxCompletionTokens: 2000 }
        : { maxTokens: 1200, temperature: 0.2 }
    case 'alignment': {
      if (modelCapability(model).gpt5Class) {
        // GPT-5 reasoning token usage needs the larger caps.
        return { maxCompletionTokens: attempt === 'primary' ? 4000 : 5000 }
      }
      const envMax = Number(
        process.env.OPENAI_MAX_TOKENS ?? CFG_MAX_TOKENS ?? 1500,
      )
      const mainMax = Math.max(1000, Math.min(1500, envMax))
      const temperature = Number(
        process.env.OPENAI_TEMPERATURE ?? CFG_TEMPERATURE ?? 0.7,
      )
      return {
        maxTokens:
          attempt === 'primary' ? mainMax : Math.min(mainMax + 500, 2000),
        // The alignment route is the one caller that omits a non-finite
        // temperature rather than sending it.
        temperature: Number.isFinite(temperature) ? temperature : undefined,
      }
    }
  }
}
