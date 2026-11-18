/**
 * Observation only: send each named call profile's real body to a candidate
 * model and report two separate verdicts — did the API accept the request, and
 * is the reply usable. One timing sample is an observation, not a latency
 * baseline.
 *
 * Nothing under `src/` is touched: this decides whether a model switch goes
 * ahead, before any route changes.
 */
import { profiles, PROFILES_VERSION } from './probe-profiles'

export type Effort = 'none' | 'low' | 'medium' | 'high'

export type ProfileId =
  | 'answer'
  | 'prefilter'
  | 'why'
  | 'relates'
  | 'alignment.schema'
  | 'alignment.tools'
  | 'alignment.json_object'
  | 'translate'

export interface ProbeProfile {
  id: ProfileId
  /** The actual messages/schema/tools this attempt sends, built by the caller.
   *  The ceiling comes in as an argument so the probe controls the budget, and the
   *  profile controls everything else — one owner per decision. */
  body: (args: {
    model: string
    effort: Effort
    budget: number
  }) => Record<string, unknown>
  /** Required shape of a usable reply — not of the request: `answer` is
   *  `json_object` and still sends no `response_format`, because the route asks
   *  for JSON in the prompt. */
  expect: 'json_object' | 'text'
  /** Keys a usable object reply must carry. A reply of `{}` parses as JSON and
   *  is worthless, so parsing alone is not the verdict. */
  requiredFields?: string[]
  /** For array-shaped replies: the minimum number of items a usable answer has.
   *  A route that silently drops rows still parses. */
  minItems?: number
  /** Passages/documents the profile was built from, for the record. */
  inputCount: number
}

export interface ProbeResult {
  ok: boolean // the API accepted the request
  usable: boolean // the reply is non-empty, complete and the expected shape
  status?: number
  error?: string
  latencyMs: number
  finishReason?: string // 'length' means the budget ran out: not usable
  shapeProblems: string[] // empty when the reply is shaped like the reply we read
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
// The ALB idle timeout: a case that outlives it cannot reach the route anyway.
const MAX_TIMEOUT_MS = 300_000

/**
 * The spec's post-migration ceilings, evaluated at this file's fixture input
 * sizes: answer `max(2000, OPENAI_MAX_TOKENS)` = 2000; prefilter 500; why
 * `min(200 + 80×25, 3000)` = 2200 (25 passages); relates `max(1000, 120×6)`
 * = 1000 (6 documents); alignment 4000 primary / 5000 repair; translate 2000.
 *
 * These are the ceilings we are migrating TO, not what today's routes would
 * send for these ids: every candidate is non-GPT-5, so today's arms would
 * send answer 1500, relates 720, translate 1200, alignment 1000/1500. The
 * probe sends the migration-shaped body (`reasoning_effort` +
 * `max_completion_tokens`), so its budget must be the target one. Re-derive
 * at the swap stage.
 */
const BUDGET: Record<ProfileId, number> = {
  answer: 2000,
  prefilter: 500,
  why: 2200,
  relates: 1000,
  'alignment.schema': 4000,
  'alignment.tools': 4000,
  'alignment.json_object': 5000,
  translate: 2000,
}

const endpoint = () =>
  (process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(
    /\/+$/,
    '',
  )

/** The reply text. The alignment route reads a function call before prose, so a
 *  forced-`tool_choice` answer that also carries content is still the tool's. */
function replyText(choice: any): string {
  const msg = choice?.message ?? {}
  const args = msg.tool_calls?.[0]?.function?.arguments
  if (typeof args === 'string' && args.trim()) return args
  return typeof msg.content === 'string' ? msg.content : ''
}

/** The routes accept bare JSON and JSON inside a markdown fence or prose. */
/**
 * What a usable reply of this profile must contain, beyond parsing. Returns the
 * problems; empty means the reply is shaped like something the caller can read.
 */
function shapeOf(parsed: any, profile: ProbeProfile): string[] {
  if (profile.expect === 'text') {
    return typeof parsed === 'string' && parsed.trim() !== ''
      ? []
      : ['reply is not text']
  }
  if (Array.isArray(parsed)) {
    const min = profile.minItems ?? 1
    return parsed.length >= min
      ? []
      : [`reply has ${parsed.length} item(s), expected at least ${min}`]
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return ['reply is not a JSON object']
  }
  const missing = (profile.requiredFields ?? []).filter((f) => !(f in parsed))
  return missing.length === 0
    ? []
    : [`reply is missing required field(s): ${missing.join(', ')}`]
}

function replyJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    // Not bare JSON: try the spans below.
  }
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ]) {
    const s = text.indexOf(open)
    const e = text.lastIndexOf(close)
    if (s === -1 || e <= s) continue
    try {
      return JSON.parse(text.slice(s, e + 1))
    } catch {
      // That span was not JSON either.
    }
  }
  return null
}

export async function probeProfile(args: {
  profile: ProbeProfile
  model: string
  effort: Effort
  budget: number
  apiKey: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<ProbeResult> {
  const { profile, model, effort, budget, apiKey, fetchImpl = fetch } = args
  const timeoutMs = Math.min(
    args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  )
  const started = Date.now()
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Raced, not just aborted: a fetch implementation may ignore the signal.
    // The body read is inside the race too, so a reply that never arrives cannot
    // outlive the timeout.
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort()
        reject(new Error(`timeout after ${timeoutMs}ms`))
      }, timeoutMs)
    })
    const call = (async () => {
      const res = await fetchImpl(`${endpoint()}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(profile.body({ model, effort, budget })),
        signal: ctrl.signal,
      })
      const json: any = await res.json().catch(() => null)
      return { res, json }
    })()
    const { res, json } = await Promise.race([call, expired])
    const choice = json?.choices?.[0] ?? {}
    const usage = json?.usage ?? {}
    const text = replyText(choice)
    const finishReason =
      choice.finish_reason ??
      (Array.isArray(choice.message?.tool_calls) ? 'tool_calls' : undefined)
    const parsed = profile.expect === 'json_object' ? replyJson(text) : text
    // Parsing is not usability. `{}`, `[]` and a reply cut off before it closes
    // all parse or read as text, and each has passed for a model that answered
    // nothing. So the verdict also requires the fields the caller will read, and
    // enough items to have covered the input.
    const shapeProblems = shapeOf(parsed, profile)
    return {
      ok: res.ok,
      usable:
        res.ok &&
        text.trim() !== '' &&
        finishReason !== undefined &&
        finishReason !== 'length' &&
        shapeProblems.length === 0,
      shapeProblems,
      status: res.status,
      ...(res.ok
        ? {}
        : { error: json?.error?.message ?? `HTTP ${res.status}` }),
      latencyMs: Date.now() - started,
      finishReason,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
    }
  } catch (err) {
    return {
      ok: false,
      usable: false,
      shapeProblems: [],
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

/* ---------------- CLI ---------------- */

// The intended task × model × effort matrix, not every pairwise combination.
// `alignment.tools` is deliberately absent: at `medium` effort that rung cannot
// succeed on Chat Completions and the migration deletes it, but it stays
// runnable with `--task alignment.tools` so the claim is measured, not assumed.
const DEFAULT_MATRIX: Array<{
  task: ProfileId
  model: string
  effort: Effort
}> = [
  { task: 'answer', model: 'gpt-6.1-sol', effort: 'medium' },
  { task: 'alignment.schema', model: 'gpt-6.1-terra', effort: 'medium' },
  { task: 'alignment.json_object', model: 'gpt-6.1-terra', effort: 'medium' },
  { task: 'why', model: 'gpt-6-luna', effort: 'none' },
  { task: 'relates', model: 'gpt-6-luna', effort: 'none' },
  { task: 'translate', model: 'gpt-6-luna', effort: 'none' },
  { task: 'prefilter', model: 'gpt-6-luna', effort: 'none' },
]

const USAGE = `usage: npm run probe:models [-- --task <id[,id]>] [--models <id[,id]>]
                             [--effort <none|low|medium|high>] [--timeout-ms <ms>]

no flags prints the default matrix. Any flag given turns the run into the
cartesian product of the requested values, defaulting to the matrix's own.
profile ids: ${Object.keys(profiles).join(', ')}`

const uniq = <T>(xs: T[]) => [...new Set(xs)]

function flagValue(argv: string[], name: string): string[] | undefined {
  const values: string[] = []
  argv.forEach((a, i) => {
    if (a === `--${name}` && argv[i + 1]) values.push(...argv[i + 1].split(','))
  })
  return values.length > 0 ? values : undefined
}

function requestedCases(argv: string[]) {
  const tasks = flagValue(argv, 'task')
  const models = flagValue(argv, 'models')
  const efforts = flagValue(argv, 'effort')
  if (!tasks && !models && !efforts) return DEFAULT_MATRIX
  const cases: typeof DEFAULT_MATRIX = []
  for (const task of tasks ?? uniq(DEFAULT_MATRIX.map((c) => c.task))) {
    for (const model of models ?? uniq(DEFAULT_MATRIX.map((c) => c.model))) {
      for (const effort of efforts ??
        uniq(DEFAULT_MATRIX.map((c) => c.effort))) {
        cases.push({ task: task as ProfileId, model, effort: effort as Effort })
      }
    }
  }
  return cases
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) {
    console.log(USAGE)
    return
  }
  const cases = requestedCases(argv)
  const unknown = cases.filter((c) => !profiles[c.task])
  if (unknown.length > 0) {
    throw new Error(`unknown profile: ${uniq(unknown.map((c) => c.task))}
${USAGE}`)
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set')

  const requestedMs = Number(
    flagValue(argv, 'timeout-ms')?.[0] ?? DEFAULT_TIMEOUT_MS,
  )
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) {
    throw new Error('--timeout-ms must be a positive number of milliseconds')
  }
  const timeoutMs = Math.min(requestedMs, MAX_TIMEOUT_MS)
  console.log(
    `probe: endpoint=${endpoint()} fixtures=${PROFILES_VERSION} timeout=${timeoutMs}ms`,
  )
  console.log(
    `efforts: ${uniq(cases.map((c) => c.effort)).join(',')}  ` +
      `budgets: ${uniq(cases.map((c) => c.task))
        .map((t) => `${t}=${BUDGET[t]}`)
        .join(' ')}`,
  )

  let failed = 0
  for (const { task, model, effort } of cases) {
    const r = await probeProfile({
      profile: profiles[task],
      model,
      effort,
      budget: BUDGET[task],
      apiKey,
      timeoutMs,
    })
    const parts = [`${r.latencyMs}ms`]
    if (r.ok) {
      parts.push(
        `in=${r.promptTokens ?? 0}`,
        `out=${r.completionTokens ?? 0}`,
        `reasoning=${r.reasoningTokens ?? 0}`,
      )
    } else {
      parts.push(String(r.status ?? '-'), r.error ?? 'request failed')
    }
    if (!r.usable) failed += 1
    console.log(
      `${r.usable ? '✓' : '✗'} ${model} ${task} ${effort} ${parts.join(' ')} ${r.usable ? 'usable' : 'not-usable'}`,
    )
  }
  console.log(`${cases.length - failed}/${cases.length} usable`)
  if (failed > 0) process.exitCode = 1
}

if (require.main === module) {
  main().catch((err) => {
    console.error(
      'probe-models:',
      err instanceof Error ? err.message : String(err),
    )
    process.exit(1)
  })
}
