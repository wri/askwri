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

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Pick model, base URL and key. The key follows the base URL: a base URL
 * equal to LUNAROUTE_BASE_URL uses LUNAROUTE_API_KEY; anything else uses
 * OPENAI_API_KEY (proxies that front OpenAI keep the OpenAI key).
 */
export function resolveProvider(
  defaultModel: string,
  override: ProviderOverride = {},
): ResolvedProvider {
  const model = (override.model ?? defaultModel).trim()
  const baseUrl = stripSlash(
    override.base_url?.trim() ||
      process.env.OPENAI_BASE_URL?.trim() ||
      OPENAI_DEFAULT_BASE_URL,
  )
  const lunaroute = process.env.LUNAROUTE_BASE_URL?.trim()
  const apiKey =
    lunaroute && stripSlash(lunaroute) === baseUrl
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
}): Promise<ChatResult> {
  const r = await fetch(`${p.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${p.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(p.body),
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
