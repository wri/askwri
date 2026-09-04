/**
 * Reliability wrapper around the app tier's single provider client (plan
 * §4.1/§4.3). The judge reuses `chatCompletion` — never its own fetch — so a
 * provider swap is a base-URL change. Policy: temperature 0 (omitted for
 * gpt-5* models, which reject it — route.ts parity), one validation-repair
 * retry, 429 backoff (initial request + up to 5 retries), one retry on
 * timeout/network/5xx, 401 aborts the run, any other 4xx is a config error
 * and tombstones without a retry, everything else degrades to an `unjudged`
 * result so one bad case never kills the pass. A timed-out request is
 * ABORTED (AbortSignal.timeout threaded into the fetch), never left in
 * flight and billing behind the retry.
 */
import { createHash } from 'node:crypto'
import { chatCompletion } from '../../src/lib/llm/chat-completions'

export class JudgeAuthError extends Error {
  constructor() {
    super('Judge provider returned 401 — aborting the run')
    this.name = 'JudgeAuthError'
  }
}

export interface JudgeUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

export interface JudgeOk<T> {
  ok: true
  verdict: T
  prompt_hash: string
  judge_model: string
  usage?: JudgeUsage
}

export interface JudgeUnjudged {
  ok: false
  unjudged: { reason: string; raw: string }
  prompt_hash: string
  judge_model: string
}

export interface JudgeCallParams<T> {
  system: string
  user: string
  validate: (json: any) => T | Error
  judgeModel: string
  baseUrl: string
  apiKey: string | undefined
  /** default 300_000 — lunaroute is ~7x slower than GPT */
  timeoutMs?: number
  /** injectable so tests back off instantly instead of sleeping */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 300_000
/** 429 backoff: 1, 2, 4, 8, 16 seconds between the initial request and its
 * 5 retries (spec §4.3: "max 5" counts retries, not total requests). */
const MAX_429_RETRIES = 5
const MAX_TOKENS = 2000

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type TransportResult =
  | { kind: 'auth' }
  | { kind: 'content'; content: string; usage?: JudgeUsage }
  | { kind: 'failed'; reason: string; raw: string }

/** Abort fired (AbortSignal.timeout) — classified by name, not instanceof
 * (undici wraps some aborts as TypeError with the DOMException in .cause). */
function isAbortError(e: unknown): boolean {
  let cur: any = e
  for (let i = 0; i < 3 && cur; i++) {
    if (cur.name === 'TimeoutError' || cur.name === 'AbortError') return true
    cur = cur.cause
  }
  return false
}

/** Mirror of route.ts: gpt-5* takes max_completion_tokens and no temperature. */
function completionParams(model: string): Record<string, unknown> {
  return /^gpt-5/i.test(model)
    ? { max_completion_tokens: MAX_TOKENS }
    : { temperature: 0, max_tokens: MAX_TOKENS }
}

/** One logical judge call with all transport-level retries applied. */
async function transport(p: {
  messages: ChatMessage[]
  judgeModel: string
  baseUrl: string
  apiKey: string
  timeoutMs: number
  sleep: (ms: number) => Promise<void>
}): Promise<TransportResult> {
  let rateLimited = 0
  let timeouts = 0
  let network = 0
  for (;;) {
    let res
    try {
      res = await chatCompletion({
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        body: {
          model: p.judgeModel,
          messages: p.messages,
          ...completionParams(p.judgeModel),
        },
        signal: AbortSignal.timeout(p.timeoutMs),
      })
    } catch (e) {
      if (isAbortError(e)) {
        timeouts++
        if (timeouts > 1)
          return {
            kind: 'failed',
            reason: 'timeout',
            raw: `no reply within ${p.timeoutMs}ms (2 attempts)`,
          }
        continue
      }
      network++
      if (network > 1)
        return { kind: 'failed', reason: 'network', raw: String(e) }
      continue
    }
    if (res.status === 401) return { kind: 'auth' }
    if (res.status === 429) {
      rateLimited++
      if (rateLimited > MAX_429_RETRIES)
        return { kind: 'failed', reason: 'rate_limited', raw: res.text }
      await p.sleep(2 ** (rateLimited - 1) * 1000)
      continue
    }
    if (res.status >= 400 && res.status < 500) {
      // A request the provider rejected (bad model, bad parameter) will be
      // rejected again — no retry; the status in the reason makes a config
      // error distinguishable from an outage in the run summary.
      return { kind: 'failed', reason: `http_${res.status}`, raw: res.text }
    }
    if (!res.ok) {
      network++
      if (network > 1)
        return { kind: 'failed', reason: 'server_error', raw: res.text }
      continue
    }
    return {
      kind: 'content',
      content: res.json?.choices?.[0]?.message?.content ?? '',
      usage: res.json?.usage,
    }
  }
}

export async function judgeCall<T>(
  p: JudgeCallParams<T>,
): Promise<JudgeOk<T> | JudgeUnjudged> {
  const prompt_hash = sha256(p.system)
  const judge_model = p.judgeModel
  const unjudged = (reason: string, raw: string): JudgeUnjudged => ({
    ok: false,
    unjudged: { reason, raw },
    prompt_hash,
    judge_model,
  })
  const call = (messages: ChatMessage[]) =>
    transport({
      messages,
      judgeModel: p.judgeModel,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey ?? '',
      timeoutMs: p.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      sleep: p.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    })

  const messages: ChatMessage[] = [
    { role: 'system', content: p.system },
    { role: 'user', content: p.user },
  ]
  let raw = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await call(messages)
    if (res.kind === 'auth') throw new JudgeAuthError()
    if (res.kind === 'failed') return unjudged(res.reason, res.raw)
    raw = res.content
    let verdict: T | Error
    try {
      verdict = p.validate(JSON.parse(raw))
    } catch (e) {
      verdict = e instanceof Error ? e : new Error(String(e))
    }
    if (!(verdict instanceof Error)) {
      return { ok: true, verdict, prompt_hash, judge_model, usage: res.usage }
    }
    // The failed reply goes back as the model's own turn, the error as ours.
    messages.push(
      { role: 'assistant', content: raw },
      {
        role: 'user',
        content: `That reply failed validation: ${verdict.message}. Reply with JSON only, matching the schema.`,
      },
    )
  }
  return unjudged('validation', raw)
}
