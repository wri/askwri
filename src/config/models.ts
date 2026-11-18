// The model registry: every model id this codebase can be configured to run,
// the capability each id has, and the task each route currently defaults to.
//
// Being KNOWN is not the same as being ASSIGNED: a candidate being in MODELS
// does not move any request onto it. ASSIGNMENT is the model each task runs —
// measured against QA, not read off the code — and a task can be backed out of a
// change through its validated `MODEL_<TASK>` lever.

export type Effort = 'none' | 'low' | 'medium' | 'high'

export type TaskId =
  'answer' | 'prefilter' | 'why' | 'relates' | 'alignment' | 'translate'

/** The incumbents (still assigned below) and the GPT-6 candidates. */
export type ModelId =
  | 'gpt-4o-mini'
  | 'gpt-5-mini'
  | 'gpt-5.4'
  | 'gpt-5.4-mini'
  | 'gpt-5.4-nano'
  | 'gpt-6-astra'
  | 'gpt-6.1-sol'
  | 'gpt-6.1-terra'
  | 'gpt-6-luna'

export type ModelTier = 'flagship' | 'balanced' | 'fast' | 'volume'

export interface ModelSpec {
  /** Cost/energy class. `energy.ts` keys its factors on this (design §4). */
  tier: ModelTier
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
    /** The GPT-6 class: takes `reasoning_effort`, and rejects `temperature`
     *  whenever the effort is not `none`. False for every incumbent, which
     *  keeps stage 1's "no effort field" promise for today's requests. */
    reasoning: boolean
  }
  /** $ per 1M tokens. Read by the pricing chore; asserted by no test this
   *  stage. Omitted where this repo holds no sourced price. */
  price?: { inputPer1M: number; outputPer1M: number }
}

export const MODELS: Record<ModelId, ModelSpec> = {
  'gpt-4o-mini': {
    tier: 'fast',
    capability: {
      gpt5Class: false,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: false,
      reasoning: false,
    },
    price: { inputPer1M: 0.15, outputPer1M: 0.6 },
  },
  'gpt-5-mini': {
    tier: 'fast',
    capability: {
      gpt5Class: true,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: true,
      reasoning: false,
    },
    price: { inputPer1M: 0.25, outputPer1M: 2.0 },
  },
  'gpt-5.4': {
    tier: 'flagship',
    capability: {
      gpt5Class: true,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: true,
      reasoning: false,
    },
    // No sourced price for this id exists in this repo (costs.ts prices
    // gpt-5-mini/gpt-5-nano); the pricing chore fills it in.
  },
  'gpt-5.4-mini': {
    tier: 'balanced',
    capability: {
      gpt5Class: true,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: true,
      reasoning: false,
    },
    // Sourced 2026-11-18: OpenAI model page — $0.75 / $4.50 per 1M short-context
    price: { inputPer1M: 0.75, outputPer1M: 4.5 },
  },
  'gpt-5.4-nano': {
    tier: 'volume',
    capability: {
      gpt5Class: true,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: true,
      reasoning: false,
    },
    // Sourced 2026-11-18: OpenAI standard rates — $0.20 / $1.25 per 1M short-context
    price: { inputPer1M: 0.2, outputPer1M: 1.25 },
  },
  // Candidates: known but unassigned. Their capability mirrors what today's
  // family tests do with these ids — the non-gpt-5 arms everywhere — so an
  // eval sweep naming one sends the same bytes as before the registry
  // existed. The swap stage re-seeds capability from probe evidence.
  'gpt-6-astra': {
    tier: 'flagship',
    capability: {
      gpt5Class: false,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: false,
      reasoning: true,
    },
    price: { inputPer1M: 10, outputPer1M: 50 },
  },
  'gpt-6.1-sol': {
    tier: 'flagship',
    capability: {
      gpt5Class: false,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: false,
      reasoning: true,
    },
    price: { inputPer1M: 2, outputPer1M: 10 },
  },
  'gpt-6.1-terra': {
    tier: 'balanced',
    capability: {
      gpt5Class: false,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: true,
      reasoning: true,
    },
    price: { inputPer1M: 1, outputPer1M: 5 },
  },
  'gpt-6-luna': {
    tier: 'volume',
    capability: {
      gpt5Class: false,
      acceptsMaxCompletionTokens: true,
      supportsEffortNone: true,
      reasoning: true,
    },
    price: { inputPer1M: 0.1, outputPer1M: 0.5 },
  },
}

/** The embedding models this repo can write rows with. Separate from `MODELS`
 *  because an embedder is priced and called differently: no output tokens, no
 *  effort, and one id per provider. `cohere-embed-v4` is the per-row value in
 *  `document_chunks.embedding_model`; the Bedrock call takes `cohere.embed-v4:0`. */
export const EMBEDDERS = {
  active: 'cohere-embed-v4',
  table: {
    'cohere-embed-v4': {
      bedrockId: 'cohere.embed-v4:0',
      // Sourced 2026-11-18: Bedrock Embed V4 input, $0.12 per 1M tokens.
      inputPer1M: 0.12,
    },
  },
} as const

/** Each task's model. Nothing in the app tier reads an env var for the model id
 *  any more: a lever may override a row here, and `resolveModel` validates it. */
export const ASSIGNMENT: Record<TaskId, ModelId> = {
  // Measured, not read off the code: `handoffs/2026-11-18-qa-baseline-models.md`
  // records one unoverridden request per route against QA image 6ad67fc. Five of
  // these rows used to hold a code default that production never ran.
  answer: 'gpt-5.4-mini',
  prefilter: 'gpt-5.4-nano', // unobservable: USE_NANO_FILTER is off on QA
  why: 'gpt-6-luna', // flip 2, 2026-11-18
  relates: 'gpt-6-luna', // flip 3, 2026-11-18
  alignment: 'gpt-6.1-terra', // flip 4, 2026-11-18: at low effort with fast mode
  translate: 'gpt-6-luna', // flip 1, 2026-11-18
}

/** Whether a model can run an effort at all. One predicate, because the lever path
 *  (resolveModel) and the per-request override path (route-model) must reject the
 *  same models — two copies drift silently (roborev job 930). */
export function canRunEffort(model: string, effort: Effort): boolean {
  if (!Object.prototype.hasOwnProperty.call(MODELS, model)) return true
  const spec = MODELS[model as ModelId]
  // Only a reasoning model is ever SENT an effort, so a flag on any other model
  // is not a refusal.
  return !(
    spec.capability.reasoning &&
    effort === 'none' &&
    !spec.capability.supportsEffortNone
  )
}

/** The effort each task runs at when its model is a reasoning model (design §2).
 *  Effort belongs to the TASK: an override inherits it rather than choosing one. */
export const TASK_EFFORT: Record<TaskId, Effort> = {
  answer: 'medium',
  prefilter: 'none',
  why: 'none',
  relates: 'none',
  // `low`, not the design's `medium` (operator ruling 2026-11-18, latency first):
  // probed on Luna and Terra, effort moved alignment latency less than the model did.
  alignment: 'low',
  translate: 'none',
}

/** Tasks that ask for the provider's fast tier (`service_tier: "fast"`), sent
 *  only on the reasoning arm. Operator ruling 2026-11-18, latency first: probed on
 *  gpt-6-luna and gpt-6.1-terra it cut batch-why 30-54% and alignment 18-48%, at a
 *  per-token premium this repo does not yet price. The other tasks are unprobed. */
export const TASK_SERVICE_TIER: Partial<Record<TaskId, 'fast'>> = {
  why: 'fast',
  alignment: 'fast',
}

/** The evidence budget, also the task's (design §1). Answer synthesis only: a
 *  candidate must not inherit the smaller non-GPT-5 arm's 6 x 350. */
export const TASK_EVIDENCE: Partial<
  Record<TaskId, { maxPassages: number; passageChars: number }>
> = {
  answer: { maxPassages: 15, passageChars: 800 },
}

/** The lever each task can be backed out through, renamed on purpose: the stale
 *  `OPENAI_MODEL*` values in the deployed secret blob are inert because nothing
 *  reads them any more. */
const LEVERS: Record<TaskId, string> = {
  answer: 'MODEL_ANSWER',
  prefilter: 'MODEL_PREFILTER',
  why: 'MODEL_WHY',
  relates: 'MODEL_RELATES',
  alignment: 'MODEL_ALIGNMENT',
  translate: 'MODEL_TRANSLATE',
}

/**
 * The one place a task's model is decided: a validated lever, else the registry.
 * Called at module scope by every consumer, so a lever naming an id the registry
 * cannot describe fails when the process loads — not at 3am on a real request.
 */
export function resolveModel(task: TaskId): ModelId {
  const lever = LEVERS[task]
  const raw = process.env[lever]?.trim()
  if (!raw) return ASSIGNMENT[task]
  if (!Object.prototype.hasOwnProperty.call(MODELS, raw)) {
    throw new Error(
      `unknown model ${raw} for ${lever}: it must name a model id the registry describes`,
    )
  }
  if (!canRunEffort(raw, TASK_EFFORT[task])) {
    throw new Error(
      `model ${raw} cannot run the ${TASK_EFFORT[task]} effort for ${task}`,
    )
  }
  return raw as ModelId
}
