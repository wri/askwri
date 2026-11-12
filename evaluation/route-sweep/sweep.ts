/**
 * Sweep stage: every route, at both models, against the deployed target, with
 * each call recorded as it came back.
 *
 * The contract of this module is that a sweep finishes. A single slow or
 * refusing call becomes a `CallResult` with `error` set — never a throw — for
 * two reasons: a sweep that dies on call nine has wasted calls one through
 * eight, and a call that failed is itself a finding (a candidate model that
 * times out is exactly how a swap breaks in production).
 */
import { execFileSync } from 'node:child_process'
import type { buildCatalogIndex } from '@/app/utils/utils'
import { buildPayloads } from './payloads'
import type { CallResult, FrozenCase, RouteName } from './types'

type CatalogIndex = ReturnType<typeof buildCatalogIndex>

export type SweepArgs = {
  cases: FrozenCase[]
  routes: RouteName[]
  models: [string, string]
  catalogIndex: CatalogIndex | null
  target: string
  token: string
  timeoutMs: number
  concurrency: number
  fetchImpl?: typeof fetch
}

/** The per-call deadline, distinct from any transport error so the record says
 * "timed out" rather than whatever the abort surfaced. */
class SweepTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timeout after ${timeoutMs}ms`)
    this.name = 'SweepTimeoutError'
  }
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

type Job = {
  index: number
  route: RouteName
  case_id: string
  model: string
  payload: Record<string, unknown>
}

/**
 * Runs one call. The deadline races the request rather than relying on the
 * transport honouring the abort signal: a fetch that ignores it would otherwise
 * hang the whole sweep. The signal is still passed, so a real request is
 * cancelled too.
 */
async function callOnce(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; ok: boolean; text: string }> {
  const controller = new AbortController()
  const attempt = (async () => {
    const res = await doFetch(url, { ...init, signal: controller.signal })
    return { status: res.status, ok: res.ok, text: await res.text() }
  })()
  // The race abandons `attempt` on timeout; this keeps a later rejection from
  // surfacing as an unhandled rejection.
  attempt.catch(() => {})

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new SweepTimeoutError(timeoutMs))
    }, timeoutMs)
  })
  try {
    return await Promise.race([attempt, deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function runCall(
  job: Job,
  ctx: {
    base: string
    token: string
    timeoutMs: number
    doFetch: typeof fetch
  },
): Promise<CallResult> {
  // The model rides in the body and the token in the header on every call: the
  // omission of either is how a sweep silently runs one model twice.
  const request = { ...job.payload, model: job.model }
  const call: CallResult = {
    route: job.route,
    case_id: job.case_id,
    model: job.model,
    request,
    response: null,
    latency_ms: 0,
  }

  const started = Date.now()
  try {
    const { status, ok, text } = await callOnce(
      ctx.doFetch,
      `${ctx.base}/api/${job.route}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-eval-token': ctx.token,
        },
        body: JSON.stringify(request),
      },
      ctx.timeoutMs,
    )
    call.response = parseBody(text)
    call.latency_ms = Date.now() - started
    if (!ok) {
      // A 400 here means the target refused the override (unset token, or one
      // that does not match). Recorded, never retried with the route's default:
      // a retry would produce a row that looks like the model answered.
      call.error = `HTTP ${status}: ${text.slice(0, 200)}`
    }
  } catch (e: any) {
    call.latency_ms = Date.now() - started
    call.error =
      e instanceof SweepTimeoutError ? e.message : String(e?.message ?? e)
  }

  call.provenance = (call.response as { provenance?: CallResult['provenance'] })
    ?.provenance
  return call
}

/**
 * Calls every route at every model for every frozen case, and returns the calls
 * in case → route → model order regardless of how many ran at once.
 *
 * A case whose retrieval returned no documents is skipped outright: every route
 * would answer over an empty input, which is not a measurement of anything and
 * still costs money on the shared key. `checkCall` rejects zero inputs as a
 * second line of defence, so such a call could never be counted as a pass.
 */
export async function runSweep(args: SweepArgs): Promise<CallResult[]> {
  const base = args.target.replace(/\/+$/, '')
  const doFetch = args.fetchImpl ?? fetch

  const jobs: Job[] = []
  for (const c of args.cases) {
    if (c.doc_count === 0) continue
    const payloads = buildPayloads(c, args.catalogIndex)
    for (const route of args.routes) {
      const payload = payloads[route] as Record<string, unknown>
      for (const model of args.models) {
        jobs.push({
          index: jobs.length,
          route,
          case_id: c.id,
          model,
          payload,
        })
      }
    }
  }

  const calls: CallResult[] = new Array(jobs.length)
  const queue = [...jobs]
  const workerCount = Math.max(1, Math.min(args.concurrency, queue.length))
  await Promise.all(
    Array.from({ length: workerCount }, () =>
      (async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          calls[job.index] = await runCall(job, {
            base,
            token: args.token,
            timeoutMs: args.timeoutMs,
            doFetch,
          })
        }
      })(),
    ),
  )

  return calls
}

/**
 * The image digest of the task actually running on a deployed service.
 *
 * Nothing the app serves reports this: the task definitions pin `:latest` and
 * `/api/health` returns only a package version, so without it a sweep would
 * have to assume which build answered. Local `git rev-parse HEAD` is the wrong
 * proxy — a sweep run after a merge against a task still on the old image would
 * read as clean.
 *
 * `describe-tasks` needs task ARNs, so the running task is listed first. Every
 * failure — no aws CLI, no permission, no running task, no digest on the
 * container — returns null. The report stage decides how loudly to say unknown;
 * this function never throws, because a provenance lookup must not end a sweep
 * whose calls are already paid for.
 */
export async function resolveCodeVersion(
  service: string,
  cluster: string,
  region: string,
): Promise<string | null> {
  const aws = (args: string[]) =>
    JSON.parse(
      execFileSync('aws', [...args, '--region', region, '--output', 'json'], {
        encoding: 'utf8',
        // stderr is where aws explains a refusal; the null return is the
        // signal this module commits to, and the report says "unknown".
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    )

  try {
    const listed = aws([
      'ecs',
      'list-tasks',
      '--cluster',
      cluster,
      '--service-name',
      service,
      '--desired-status',
      'RUNNING',
    ])
    const taskArn: unknown = listed?.taskArns?.[0]
    if (typeof taskArn !== 'string' || !taskArn) return null

    const described = aws([
      'ecs',
      'describe-tasks',
      '--cluster',
      cluster,
      '--tasks',
      taskArn,
    ])
    const containers: any[] = described?.tasks?.[0]?.containers ?? []
    const digest = containers.find(
      (c) => typeof c?.imageDigest === 'string' && c.imageDigest,
    )?.imageDigest
    return typeof digest === 'string' && digest ? digest : null
  } catch {
    return null
  }
}
