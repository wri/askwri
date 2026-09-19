/**
 * One OpenAI-compatible chat-completions client for the app tier.
 *
 * Every LLM call that used to hardcode https://api.openai.com goes through
 * here, so a different provider (lunaroute for GLM, a proxy, a local server)
 * is a base-URL change, not a code change. The eval harness's synthesis
 * candidates depend on this: the same route, the same prompt, a different
 * `base_url` + `model`.
 */

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

export interface ProviderOverride {
  model?: string
  base_url?: string
}

export interface ResolvedProvider {
  model: string
  baseUrl: string
  apiKey: string | undefined
  /** gpt-5* takes max_completion_tokens and no temperature. */
  isGpt5: boolean
}

export class UnsupportedProviderBaseUrlError extends Error {
  constructor() {
    super('Unsupported provider base_url')
    this.name = 'UnsupportedProviderBaseUrlError'
  }
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Pick model, base URL and key. A request override must match one of the two
 * configured provider URLs; the matching URL selects its corresponding key.
 * This prevents a caller-controlled URL from receiving a provider credential.
 */
export function resolveProvider(
  defaultModel: string,
  override: ProviderOverride = {},
): ResolvedProvider {
  const model = (override.model ?? defaultModel).trim()
  const openaiBaseUrl = stripSlash(
    process.env.OPENAI_BASE_URL?.trim() || OPENAI_DEFAULT_BASE_URL,
  )
  const lunaroute = process.env.LUNAROUTE_BASE_URL?.trim()
  const lunarouteBaseUrl = lunaroute ? stripSlash(lunaroute) : undefined
  const requestedBaseUrl = override.base_url?.trim()
  const baseUrl = stripSlash(requestedBaseUrl || openaiBaseUrl)
  if (
    requestedBaseUrl &&
    baseUrl !== openaiBaseUrl &&
    baseUrl !== lunarouteBaseUrl
  ) {
    throw new UnsupportedProviderBaseUrlError()
  }
  const apiKey =
    lunarouteBaseUrl === baseUrl
      ? process.env.LUNAROUTE_API_KEY?.trim()
      : process.env.OPENAI_API_KEY?.trim()
  return { model, baseUrl, apiKey, isGpt5: /^gpt-5/i.test(model) }
}

export interface ChatResult {
  status: number
  ok: boolean
  text: string
  json: any
}

export async function chatCompletion(p: {
  baseUrl: string
  apiKey: string
  body: Record<string, unknown>
  /** Optional abort signal (e.g. AbortSignal.timeout) — a caller-side
   * timeout then cancels the request instead of leaving it in flight. */
  signal?: AbortSignal
}): Promise<ChatResult> {
  const r = await fetch(`${p.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${p.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(p.body),
    ...(p.signal ? { signal: p.signal } : {}),
  })
  const text = await r.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  return { status: r.status, ok: r.ok, text, json }
}
