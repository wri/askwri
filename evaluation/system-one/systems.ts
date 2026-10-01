/**
 * Pluggable competitors for the System One harness.
 *
 * To test a new variant, write one `pick` function and add it to
 * `defaultSystems`. Nothing else in the harness knows about any provider.
 *
 * Every system gets the identical `state`, `question` and `candidates`, so the
 * comparison is apples-to-apples by construction.
 */

const TIMEOUT_MS = 120_000

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

/** Candidate line as the classify stage renders it: `- label (aka: x; description)`. */
function renderCandidate(c: Candidate): string {
  const details = [
    c.aliases.length ? `aka: ${c.aliases.join(', ')}` : '',
    c.description ?? '',
  ].filter(Boolean)
  return `- ${c.label}${details.length ? ` (${details.join('; ')})` : ''}`
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
 */
export function llm(model: string, baseUrl = 'https://api.openai.com/v1'): System {
  return {
    id: `llm:${model}`,
    note: `json_schema — production worker/llm.py shape`,
    async pick({ state, question, candidates }) {
      const key = process.env.OPENAI_API_KEY
      if (!key) throw new Error('OPENAI_API_KEY not set')

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
          content: `${question} Return JSON: {"value": <one candidate value>, "confidence": <0..1>}.`,
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
              max_completion_tokens: 600 * attempt,
              messages,
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

const DEFAULT_SYSTEMONE_MODELS = ['kev-4b', 'djev']
const DEFAULT_LLM_MODELS = ['gpt-5.6-luna']

export function defaultSystems(): System[] {
  return [
    ...DEFAULT_LLM_MODELS.map((m) => llm(m)),
    ...DEFAULT_SYSTEMONE_MODELS.map((m) => systemOne(m)),
    embeddingBaseline(),
  ]
}

/** `--systems systemone:kev-4b,llm:gpt-5.6-luna` → those systems only. */
export function systemsFromIds(ids: string[]): System[] {
  return ids.map((id) => {
    const [kind, ...rest] = id.split(':')
    const model = rest.join(':')
    if (kind === 'systemone') return systemOne(model)
    if (kind === 'llm') return llm(model)
    if (kind === 'embedding') return embeddingBaseline()
    throw new Error(`unknown system id "${id}" (use systemone:<model>, llm:<model>, embedding)`)
  })
}
