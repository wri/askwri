/**
 * Pluggable competitors for the System One harness.
 *
 * To test a new variant, write one `pick` function and add it to
 * `defaultSystems`. Nothing else in the harness knows about any provider.
 *
 * Every system gets the identical `state`, `question` and `candidates`, so the
 * comparison is apples-to-apples by construction.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const TIMEOUT_MS = 300_000

/** TypeSafe `choice` takes at most 255 options (their published limit). */
const CHOICE_CAP = 255

export type Candidate = {
  label: string
  description: string | null
  aliases: string[]
  /** cosine distance to the document vector from the summary chunk embedding */
  distance: number
}

/** A system's answer. `label: null` means it produced nothing usable. */
export type Pick = {
  label: string | null
  /** Self-reported confidence in [0,1], or null when the system has none. */
  confidence: number | null
  /** Full distribution over candidate labels, when the system supplies one. */
  probabilities?: Record<string, number>
  error?: string
}

export type PickCtx = {
  /** The document basis — exactly what worker/stages/classify.py passes. */
  state: string
  /** One instruction string, identical for every system. */
  question: string
  candidates: Candidate[]
}

export type System = {
  id: string
  note: string
  pick(ctx: PickCtx): Promise<Pick>
}

/** Candidate line as the classify stage renders it. The label is quoted so a
 * model cannot mistake the description for the value — unquoted, opus returned
 * `"Public Finance (aka: urban finance, ..."` and the call had to be discarded. */
function renderCandidate(c: Candidate): string {
  const details = [
    c.aliases.length ? `aka: ${c.aliases.join(', ')}` : '',
    c.description ?? '',
  ].filter(Boolean)
  return `- "${c.label}"${details.length ? ` — ${details.join('; ')}` : ''}`
}

/**
 * TypeSafe System One `choice` primitive, over any server that speaks the
 * `/v1/systemone` contract — hosted Jev, the lunaroute gateway (djev,
 * kev-4b), or a self-hosted Kev of any size.
 */
export function systemOne(model: string, baseUrl?: string): System {
  const base = baseUrl ?? process.env.SYSTEMONE_BASE_URL ?? 'https://gw.lunaroute.com/v1'
  return {
    id: `systemone:${model}`,
    note: `${base} — choice primitive`,
    async pick({ state, question, candidates }) {
      const key = process.env.SYSTEMONE_API_KEY ?? process.env.LUNAROUTE_API_KEY
      if (!key) throw new Error('SYSTEMONE_API_KEY (or LUNAROUTE_API_KEY) not set')
      if (candidates.length > CHOICE_CAP) {
        return {
          label: null,
          confidence: null,
          error: `choice capped at ${CHOICE_CAP} options, got ${candidates.length}`,
        }
      }

      const criteria: Record<string, string> = {}
      for (const c of candidates) {
        const details = [
          c.aliases.length ? `aka: ${c.aliases.join(', ')}` : '',
          c.description ?? '',
        ].filter(Boolean)
        criteria[c.label] = details.length ? details.join('; ') : c.label
      }

      const res = await fetch(`${base}/systemone`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          state,
          model,
          questions: { pick: { type: 'choice', instructions: question, criteria } },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        return { label: null, confidence: null, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
      }

      const body = await res.json()
      const a = body?.answers?.pick
      if (!a || a.type !== 'choice' || typeof a.choice !== 'string') {
        return { label: null, confidence: null, error: 'malformed choice answer' }
      }
      return {
        label: a.choice,
        confidence: typeof a.confidence === 'number' ? a.confidence : null,
        probabilities: a.probabilities,
      }
    },
  }
}

/**
 * The incumbent: one chat call with strict json_schema output, reproducing
 * search-service/worker/llm.py `chat_json` (including its single retry with a
 * doubled token budget). Retry exhaustion or an out-of-enum value is recorded
 * as a failure rather than patched over — that failure rate is a real metric.
 *
 * `reasoningEffort` is provider-specific and materially changes the answer, so
 * it is recorded in `note` and written into the artifact.
 */
export function llm(
  model: string,
  opts: { baseUrl?: string; apiKey?: string; reasoningEffort?: string; maxTokens?: number } = {},
): System {
  const baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1'
  const keyEnv = opts.apiKey
  // Production's chat_json defaults to 1500. A reasoning model spends its
  // budget on reasoning first, so a tighter number starves the answer:
  // deepseek with reasoning_effort=high returned finish_reason=length and empty
  // content on 5 of 15 documents at 600.
  const maxTokens = opts.maxTokens ?? 1500
  return {
    id: `llm:${model}`,
    note:
      `${opts.baseUrl ?? 'api.openai.com'} — json_schema, production worker/llm.py shape` +
      (opts.reasoningEffort ? `, reasoning_effort=${opts.reasoningEffort}` : ', provider default thinking'),
    async pick({ state, question, candidates }) {
      const key = keyEnv
      if (!key) {
        throw new Error(
          `${opts.baseUrl ? 'lunaroute gateway (LUNAROUTE_API_KEY / SYSTEMONE_API_KEY)' : 'OPENAI_API_KEY'} not set`,
        )
      }

      const labels = candidates.map((c) => c.label)
      const schema = {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: { type: 'string', enum: labels },
          confidence: { type: 'number' },
        },
        required: ['value', 'confidence'],
      }
      const messages = [
        {
          role: 'system',
          content:
            `${question} Return JSON: {"value": <one candidate value>, "confidence": <0..1>}. ` +
            `"value" must be exactly the label text shown in quotes in the candidate list, with no ` +
            `description or alias text appended.`,
        },
        { role: 'user', content: `${state}\n\nCandidates:\n${candidates.map(renderCandidate).join('\n')}` },
      ]

      let last: string | null = null
      for (let attempt = 1; attempt <= 2; attempt++) {
        let res: Response
        try {
          res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model,
              max_completion_tokens: maxTokens * attempt,
              messages,
              ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'result', strict: true, schema },
              },
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
        } catch (e) {
          last = `fetch failed: ${e}`
          continue
        }
        if (!res.ok) {
          last = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
          continue
        }

        const choice = (await res.json())?.choices?.[0]
        const content = choice?.message?.content
        if (!content) {
          last = `empty content (finish_reason=${choice?.finish_reason})`
          continue
        }
        try {
          const parsed = JSON.parse(content)
          if (!labels.includes(parsed.value)) {
            last = `out-of-enum value: ${JSON.stringify(parsed.value)}`
            continue
          }
          return {
            label: parsed.value,
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
          }
        } catch {
          last = 'unparseable JSON'
        }
      }
      return { label: null, confidence: null, error: last ?? 'failed' }
    },
  }
}

/**
 * Zero-model floor: whatever cosine similarity already ranks first.
 *
 * By construction this IS the candidate-recall ceiling in top-N mode, so it
 * answers the question "is the LLM call buying anything over the retrieval we
 * already pay for?" A model that cannot beat this line is not earning its call.
 */
export function embeddingBaseline(): System {
  return {
    id: 'embedding:cohere-embed-v4',
    note: 'argmax cosine — the recall ceiling, no model call',
    async pick({ candidates }) {
      const top = candidates[0]
      return top
        ? { label: top.label, confidence: null }
        : { label: null, confidence: null, error: 'no candidates' }
    },
  }
}

/**
 * Claude on Bedrock, via the AWS CLI rather than a new SDK dependency.
 *
 * Anthropic models on Bedrock need a cross-region inference profile, not the
 * bare model id, and thinking uses the newer `adaptive` + `output_config`
 * shape. Structured output is instructed in the prompt and validated here — a
 * parse failure loses a label, it does not corrupt one.
 *
 * ponytail: one `aws` process per call. Swap to @aws-sdk/client-bedrock-runtime
 * if spawn overhead ever matters at this scale.
 */
export function bedrockClaude(model: string, effort = 'high'): System {
  const region = process.env.BEDROCK_REGION ?? 'us-east-2'
  return {
    id: `bedrock:${model}`,
    note: `bedrock ${region}, thinking=adaptive effort=${effort}`,
    async pick({ state, question, candidates }) {
      const labels = candidates.map((c) => c.label)
      const user =
        `${state}\n\nCandidates:\n${candidates.map(renderCandidate).join('\n')}\n\n` +
        `Reply with JSON only, no prose: {"value": <one of the candidates>, "confidence": <0..1>}`

      let stdout: string
      try {
        ;({ stdout } = await execFileAsync(
          'aws',
          [
            'bedrock-runtime', 'converse',
            '--region', region,
            '--model-id', model,
            '--system', JSON.stringify([{ text: question }]),
            '--messages', JSON.stringify([{ role: 'user', content: [{ text: user }] }]),
            '--inference-config', JSON.stringify({ maxTokens: 8000 }),
            '--additional-model-request-fields',
            JSON.stringify({ thinking: { type: 'adaptive' }, output_config: { effort } }),
            '--query', 'output.message.content[-1].text',
            '--output', 'text',
          ],
          { maxBuffer: 32 * 1024 * 1024, timeout: TIMEOUT_MS },
        ))
      } catch (e) {
        return { label: null, confidence: null, error: `aws cli: ${String(e).slice(0, 300)}` }
      }

      // The answer may still arrive wrapped in prose or a fenced block.
      const match = stdout.match(/\{[\s\S]*\}/)
      if (!match) return { label: null, confidence: null, error: `no JSON in reply: ${stdout.slice(0, 120)}` }
      try {
        const parsed = JSON.parse(match[0])
        if (!labels.includes(parsed.value)) {
          return { label: null, confidence: null, error: `out-of-enum value: ${JSON.stringify(parsed.value)}` }
        }
        return {
          label: parsed.value,
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
        }
      } catch {
        return { label: null, confidence: null, error: `unparseable JSON: ${match[0].slice(0, 120)}` }
      }
    },
  }
}

/**
 * Multi-label answer: P(this tag applies) for every candidate tag.
 *
 * Production attaches 0-5 tags per document with a per-tag confidence, so this
 * — not single-select `choice` — is the shape that matches what would ship.
 */
export type MultiPick = {
  scores: Record<string, number>
  error?: string
}

export type MultiSystem = {
  id: string
  note: string
  apply(state: string, candidates: Candidate[]): Promise<MultiPick>
}

/**
 * One question per candidate tag. Identical text for every generator, so a
 * difference in the answer is a difference in the model alone.
 */
function noulQuestion(c: Candidate): string {
  const details = [
    c.aliases.length ? `aka: ${c.aliases.join(', ')}` : '',
    c.description ?? '',
  ].filter(Boolean)
  return (
    `Does the topic tag "${c.label}"${details.length ? ` (${details.join('; ')})` : ''} ` +
    `clearly apply to this document as one of its main topics? ` +
    `Answer yes only if the document substantively addresses it.`
  )
}

/**
 * System One `noul` per candidate — the deployable shape for top-5 tagging.
 *
 * Chunks the candidate set into requests of `maxQuestions`, because the servers
 * disagree on how many questions they accept: djev caps at 32, kev-4b took 60,
 * and hosted Jev took 255 (all measured 2026-10-01). Chunking is what makes a
 * full-vocabulary run possible at all — `topic` has 757 tags.
 */
export function systemOneNoul(
  model: string,
  opts: {
    baseUrl?: string
    apiKey?: string
    maxQuestions?: number
    id?: string
  } = {},
): MultiSystem {
  const base = opts.baseUrl ?? process.env.SYSTEMONE_BASE_URL ?? 'https://gw.lunaroute.com/v1'
  const maxQuestions = opts.maxQuestions ?? 32
  return {
    id: opts.id ?? `systemone:${model}`,
    note: `${base} — noul per candidate, ${maxQuestions} per request`,
    async apply(state, candidates) {
      const key =
        opts.apiKey ?? process.env.SYSTEMONE_API_KEY ?? process.env.LUNAROUTE_API_KEY
      if (!key) throw new Error('no API key for ' + base)

      const scores: Record<string, number> = {}
      for (let start = 0; start < candidates.length; start += maxQuestions) {
        const batch = candidates.slice(start, start + maxQuestions)
        const questions: Record<string, unknown> = {}
        batch.forEach((c, i) => {
          questions[`t${i}`] = { type: 'noul', instructions: noulQuestion(c) }
        })

        let res: Response
        try {
          res = await fetch(`${base}/systemone`, {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ state, model, questions }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
        } catch (e) {
          return { scores, error: `batch failed: ${String(e).slice(0, 120)}` }
        }
        if (!res.ok) {
          return { scores, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
        }
        const answers = (await res.json())?.answers ?? {}
        batch.forEach((c, i) => {
          const a = answers[`t${i}`]
          if (typeof a?.noul === 'number') scores[c.label] = a.noul
        })
      }

      if (Object.keys(scores).length !== candidates.length) {
        return { scores, error: `only ${Object.keys(scores).length}/${candidates.length} answered` }
      }
      return { scores }
    },
  }
}

/**
 * Hosted Jev, TypeSafe's reference implementation.
 *
 * 255 questions per request measured; the whole 757-tag topic vocabulary is
 * therefore 3 requests per document.
 */
export function jev(model = process.env.JEV_MODEL ?? 'jev-latest'): MultiSystem {
  return systemOneNoul(model, {
    baseUrl: process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai/v1',
    apiKey: process.env.TYPESAFE_API_KEY,
    maxQuestions: 255,
    id: `jev:${model}`,
  })
}

/**
 * Cosine similarity over the tag embeddings — no model call at all.
 *
 * The free floor: whatever retrieve-then-classify would pick before any model
 * sees it. Only meaningful on an embedded facet; on a non-embedded one every
 * candidate carries distance 0 and the scores say nothing.
 */
export function cosineNoul(): MultiSystem {
  return {
    id: 'cosine:cohere-embed-v4',
    note: 'cosine similarity over tag embeddings — no model call',
    async apply(_state, candidates) {
      if (!candidates.length) return { scores: {}, error: 'no candidates' }
      const embedded = candidates.filter((c) => c.distance !== 0).length
      if (!embedded) {
        return {
          scores: {},
          error: 'facet has no tag embeddings — cosine has nothing to rank',
        }
      }
      const scores: Record<string, number> = {}
      for (const c of candidates) scores[c.label] = 1 - c.distance
      return { scores }
    },
  }
}

/** Multi-label systems by id, for `--generators` in noul mode. */
export function multiSystemsFromIds(ids: string[]): MultiSystem[] {
  return ids.map((id) => {
    const [kind, ...rest] = id.split(':')
    const model = rest.join(':')
    if (kind === 'jev') return jev(model || undefined)
    if (kind === 'cosine') return cosineNoul()
    if (kind === 'systemone') return systemOneNoul(model)
    if (kind === 'bedrock') return bedrockNoul(model)
    if (kind === 'llm') return llmNoul(model, { apiKey: process.env.OPENAI_API_KEY })
    if (kind === 'gw') {
      return llmNoul(model, { baseUrl: GATEWAY, apiKey: gatewayKey(), maxTokens: 4000 })
    }
    throw new Error(
      `unknown multi-system id "${id}" (use jev:<model>, cosine, systemone:<model>, bedrock:<profile>, llm:<model>, gw:<model>)`,
    )
  })
}

/**
 * The same per-tag question set, asked of an LLM in one call returning a
 * probability per tag. Uniform with `systemOneNoul` so agreement is measured
 * on like evidence.
 */
export function llmNoul(
  model: string,
  opts: { baseUrl?: string; apiKey?: string; reasoningEffort?: string; maxTokens?: number } = {},
): MultiSystem {
  const baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1'
  return {
    id: `llm:${model}`,
    note:
      `${opts.baseUrl ?? 'api.openai.com'} — noul per candidate, one call` +
      (opts.reasoningEffort ? `, reasoning_effort=${opts.reasoningEffort}` : ''),
    async apply(state, candidates) {
      const key = opts.apiKey
      if (!key) throw new Error('API key not set')
      const props: Record<string, unknown> = {}
      for (const c of candidates) props[c.label] = { type: 'number' }
      const schema = {
        type: 'object',
        additionalProperties: false,
        properties: props,
        required: candidates.map((c) => c.label),
      }
      const questions = candidates.map((c, i) => `${i + 1}. ${noulQuestion(c)}`).join('\n')
      const messages = [
        {
          role: 'system',
          content:
            'For each numbered question, give the probability in [0,1] that it applies. ' +
            'Return JSON keyed by the exact tag name in quotes, with a probability for every tag.',
        },
        { role: 'user', content: `${state}\n\nQuestions:\n${questions}` },
      ]
      let last: string | null = null
      for (let attempt = 1; attempt <= 2; attempt++) {
        let res: Response
        try {
          res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model,
              max_completion_tokens: (opts.maxTokens ?? 1500) * attempt,
              messages,
              ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'result', strict: true, schema },
              },
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
        } catch (e) {
          last = `fetch failed: ${e}`
          continue
        }
        if (!res.ok) {
          last = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
          continue
        }
        const choice = (await res.json())?.choices?.[0]
        const content = choice?.message?.content
        if (!content) {
          last = `empty content (finish_reason=${choice?.finish_reason})`
          continue
        }
        try {
          const parsed = JSON.parse(content)
          const scores: Record<string, number> = {}
          for (const c of candidates) {
            const v = parsed[c.label]
            if (typeof v === 'number') scores[c.label] = v
          }
          if (Object.keys(scores).length !== candidates.length) {
            last = `only ${Object.keys(scores).length}/${candidates.length} keys returned`
            continue
          }
          return { scores }
        } catch {
          last = 'unparseable JSON'
        }
      }
      return { scores: {}, error: last ?? 'failed' }
    },
  }
}

/** Bedrock Claude, same per-tag question set, one call. */
export function bedrockNoul(model: string, effort = 'high'): MultiSystem {
  const region = process.env.BEDROCK_REGION ?? 'us-east-2'
  return {
    id: `bedrock:${model}`,
    note: `bedrock ${region}, noul per candidate, thinking=adaptive effort=${effort}`,
    async apply(state, candidates) {
      const questions = candidates.map((c, i) => `${i + 1}. ${noulQuestion(c)}`).join('\n')
      const user =
        `${state}\n\nQuestions:\n${questions}\n\n` +
        'Reply with JSON only, keyed by the exact tag name in quotes, giving a probability in ' +
        '[0,1] for every tag. No prose.'
      let stdout: string
      try {
        ;({ stdout } = await execFileAsync(
          'aws',
          [
            'bedrock-runtime', 'converse',
            '--region', region,
            '--model-id', model,
            '--system',
            JSON.stringify([
              {
                text:
                  'For each numbered question, give the probability in [0,1] that it applies. ' +
                  'Return a JSON object keyed by the exact tag names.',
              },
            ]),
            '--messages', JSON.stringify([{ role: 'user', content: [{ text: user }] }]),
            '--inference-config', JSON.stringify({ maxTokens: 12000 }),
            '--additional-model-request-fields',
            JSON.stringify({ thinking: { type: 'adaptive' }, output_config: { effort } }),
            '--query', 'output.message.content[-1].text',
            '--output', 'text',
          ],
          { maxBuffer: 32 * 1024 * 1024, timeout: TIMEOUT_MS },
        ))
      } catch (e) {
        return { scores: {}, error: `aws cli: ${String(e).slice(0, 300)}` }
      }
      const match = stdout.match(/\{[\s\S]*\}/)
      if (!match) return { scores: {}, error: `no JSON in reply: ${stdout.slice(0, 120)}` }
      try {
        const parsed = JSON.parse(match[0])
        const scores: Record<string, number> = {}
        for (const c of candidates) {
          const v = parsed[c.label]
          if (typeof v === 'number') scores[c.label] = v
        }
        if (!Object.keys(scores).length) {
          return { scores: {}, error: `no tag keys in reply; got: ${match[0].slice(0, 300)}` }
        }
        return { scores }
      } catch {
        return { scores: {}, error: `unparseable JSON: ${match[0].slice(0, 120)}` }
      }
    },
  }
}

/** The four generators in the uniform per-tag shape. */
export function defaultMultiGenerators(): MultiSystem[] {
  return [
    bedrockNoul('us.anthropic.claude-opus-5-5'),
    bedrockNoul('us.anthropic.claude-sonnet-5-5'),
    llmNoul('glm-5.3', { baseUrl: GATEWAY, apiKey: gatewayKey(), maxTokens: 4000 }),
    llmNoul('deepseek-4.1-flash', {
      baseUrl: GATEWAY,
      apiKey: gatewayKey(),
      reasoningEffort: 'high',
      maxTokens: 4000,
    }),
  ]
}

const DEFAULT_SYSTEMONE_MODELS = ['kev-4b', 'djev']
const DEFAULT_LLM_MODELS = ['gpt-5.6-luna']

const GATEWAY = process.env.LUNAROUTE_BASE_URL ?? 'https://gw.lunaroute.com/v1'
const gatewayKey = () => process.env.LUNAROUTE_API_KEY || process.env.SYSTEMONE_API_KEY

export function defaultSystems(): System[] {
  return [
    ...DEFAULT_LLM_MODELS.map((m) => llm(m, { apiKey: process.env.OPENAI_API_KEY })),
    ...DEFAULT_SYSTEMONE_MODELS.map((m) => systemOne(m)),
    embeddingBaseline(),
  ]
}

/**
 * Candidate label generators for the consensus path.
 *
 * None of these is on the test bench — that is the whole point. A generator
 * that is also being evaluated would make itself the winner by construction.
 *
 * Opus and Sonnet are the same family, so two of the four votes are correlated.
 * They are both here on purpose: comparing their agreement rate against the
 * cross-family rate measures that correlation instead of assuming it.
 */
export function defaultGenerators(): System[] {
  return [
    bedrockClaude('us.anthropic.claude-opus-5-5'),
    bedrockClaude('us.anthropic.claude-sonnet-5-5'),
    llm('glm-5.3', { baseUrl: GATEWAY, apiKey: gatewayKey(), maxTokens: 4000 }),
    llm('deepseek-4.1-flash', {
      baseUrl: GATEWAY,
      apiKey: gatewayKey(),
      reasoningEffort: 'high',
      maxTokens: 4000,
    }),
  ]
}

/** `--systems systemone:kev-4b,llm:gpt-5.6-luna` → those systems only. */
export function systemsFromIds(ids: string[]): System[] {
  return ids.map((id) => {
    const [kind, ...rest] = id.split(':')
    const model = rest.join(':')
    if (kind === 'systemone') return systemOne(model)
    if (kind === 'llm') return llm(model, { apiKey: process.env.OPENAI_API_KEY })
    if (kind === 'gw') return llm(model, { baseUrl: GATEWAY, apiKey: gatewayKey() })
    if (kind === 'bedrock') return bedrockClaude(model)
    if (kind === 'embedding') return embeddingBaseline()
    throw new Error(
      `unknown system id "${id}" (use systemone:<model>, llm:<model>, gw:<model>, bedrock:<profile>, embedding)`,
    )
  })
}
