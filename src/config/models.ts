// The model registry: every model id this codebase can be configured to run,
// the capability each id has, and the task each route currently defaults to.
//
// Being KNOWN is not the same as being ASSIGNED: a candidate being in MODELS
// does not move any request onto it. ASSIGNMENT records each task's CURRENT
// CODE DEFAULT — not the value production runs, which arrives through the
// OPENAI_MODEL* env vars whose precedence this stage leaves untouched.

export type Effort = 'none' | 'low' | 'medium' | 'high'

export type TaskId =
  'answer' | 'prefilter' | 'why' | 'relates' | 'alignment' | 'translate'

/** The incumbents (still assigned below) and the GPT-6 candidates. */
export type ModelId =
  | 'gpt-4o-mini'
  | 'gpt-5-mini'
  | 'gpt-5.4'
  | 'gpt-5.4-nano'
  | 'gpt-6-astra'
  | 'gpt-6.1-sol'
  | 'gpt-6.1-terra'
  | 'gpt-6-luna'

export interface ModelSpec {
  capability: {
    /** The gpt-5 completions contract: max_completion_tokens, no temperature,
     *  the gpt-5 budget and timeout ladders. Exactly today's /^gpt-5/i arm. */
    gpt5Class: boolean
    /** Accepts the max_completion_tokens parameter: gpt-4o onward, and the whole
     *  GPT-6 class — `npm run probe:models` sends it at the task's effort and got
     *  an accepted, usable reply on every GPT-6 case. An id that does not accept
     *  it gets max_tokens instead. */
    acceptsMaxCompletionTokens: boolean
    /** effort:'none' is supported — declared now, first sent at migration. */
    supportsEffortNone: boolean
  }
  /** $ per 1M tokens. Read by the pricing chore; asserted by no test this
   *  stage. Omitted where this repo holds no sourced price. */
  price?: { inputPer1M: number; outputPer1M: number }
}

export const MODELS: Record<ModelId, ModelSpec> = {
  'gpt-4o-mini': {
    capability: {
      gpt5Class: false,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: false,
    },
    price: { inputPer1M: 0.15, outputPer1M: 0.6 },
  },
  'gpt-5-mini': {
    capability: {
      gpt5Class: true,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: true,
    },
    price: { inputPer1M: 0.25, outputPer1M: 2.0 },
  },
  'gpt-5.4': {
    capability: {
      gpt5Class: true,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: true,
    },
    // No sourced price for this id exists in this repo (costs.ts prices
    // gpt-5-mini/gpt-5-nano); the pricing chore fills it in.
  },
  'gpt-5.4-nano': {
    capability: {
      gpt5Class: true,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: true,
    },
  },
  // Candidates: known but unassigned. Their capability mirrors what today's
  // family tests do with these ids — the non-gpt-5 arms everywhere — so an
  // eval sweep naming one sends the same bytes as before the registry
  // existed. The swap stage re-seeds capability from probe evidence.
  'gpt-6-astra': {
    capability: {
      gpt5Class: false,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: false,
    },
    price: { inputPer1M: 10, outputPer1M: 50 },
  },
  'gpt-6.1-sol': {
    capability: {
      gpt5Class: false,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: false,
    },
    price: { inputPer1M: 2, outputPer1M: 10 },
  },
  'gpt-6.1-terra': {
    capability: {
      gpt5Class: false,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: true,
    },
    price: { inputPer1M: 1, outputPer1M: 5 },
  },
  'gpt-6-luna': {
    capability: {
      gpt5Class: false,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: true,
    },
    price: { inputPer1M: 0.1, outputPer1M: 0.5 },
  },
}

/** Each task's CURRENT CODE DEFAULT — not the value production runs.
 *  Production overrides these through OPENAI_MODEL*, and that precedence is
 *  untouched in this stage. */
export const ASSIGNMENT: Record<TaskId, ModelId> = {
  answer: 'gpt-5.4',
  prefilter: 'gpt-5.4-nano',
  why: 'gpt-4o-mini',
  relates: 'gpt-4o-mini',
  // The alignment route's env chain bottoms out at src/config/alignment's
  // gpt-4o-mini default; its 'gpt-5-mini' tail is unreachable with no env.
  alignment: 'gpt-4o-mini',
  translate: 'gpt-5-mini',
}
