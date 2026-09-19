/**
 * fetchJson — the harness's only HTTP primitive.
 *
 * SPIKE CONCLUSION (§3.6, 2026-09-03): NON-REPRODUCTION on the current
 * stack, so the mitigation is defensive. The documented hang (spec §1 table;
 * `eval-minimal.ts` header, 2026-08-25 — "avoids the harness's fetch hang by
 * using child_process curl per query") did not reproduce under Node
 * v24.15.0 against a local `next dev` (Next.js 16.3.3, Turbopack) with a stub
 * upstream. Four instrumented scenarios, 461 requests total, all with the
 * exact `run-evalset.ts` call shape (same headers, same
 * `AbortSignal.timeout(120_000)`, sequential POSTs to /api/llamaindex) and a
 * watchdog logging `process.getActiveResourcesInfo()` for any request older
 * than 30s: (1) tight loop, 250 requests, instant stub — no hang; (2) paced
 * loop with 4s idle gaps between requests (exercising undici keep-alive pool
 * expiry against server-side socket closes), 120 requests — no hang; (3)
 * slow upstream (2-6s per response, matching real search-service latency), 60
 * requests — no hang; (4) same with a genuine mid-run content edit to
 * src/config/retrieval.ts forcing a Turbopack rebuild of the route mid-flight
 * (the HMR/half-closed-socket hypothesis), 30 requests — no hang. No request
 * exceeded 6s, the watchdog never fired, no abort ever tripped. The brief's
 * hypotheses — dead-socket undici pool reuse, body read escaping the abort
 * signal, compile-stall — were each exercised directly and none stalled. The
 * original report predates this Node/undici generation and named no mechanism,
 * so the most defensible reading is an environment-specific failure that
 * current Node no longer exhibits; a non-reproduction with this evidence is
 * the spike's honest result. Mitigation (the package-free fallback the plan
 * names for exactly this outcome): every request runs under ONE
 * `AbortSignal.timeout` covering dispatch, headers, AND the full body read
 * (`res.text()` is awaited inside the signal's coverage), plus one retry on
 * timeout/network error so a single dead socket or slow response cannot
 * wedge a run. If the hang ever reproduces, escalate to an explicit undici
 * Agent (devDependency) — not attempted here because there is nothing to
 * mitigate against. Reproduction recipe (all scratch, nothing committed):
 * a ~20-line node http.Server on 127.0.0.1:8000 answering POST /query with
 * canned `{docs: [...], total_results, debug: {total_ms}, usage: {total_usd}}`
 * and GET /health with JSON — the Next gateway proxies to it with zero env
 * vars (SEARCH_SERVICE_URL defaults to http://localhost:8000). Start `next dev`
 * in the worktree, warm the route once (first request pays the on-demand
 * compile), then sequential POSTs of {query, mode: 'answer'} to
 * http://127.0.0.1:<port>/api/llamaindex with `Content-Type: application/json`
 * and `AbortSignal.timeout(120_000)`, logging start/end per request. Run the
 * four scenarios: (1) tight loop, instant stub, 250 requests; (2) paced loop
 * with 4s idle gaps, 120 requests — exercises undici keep-alive pool expiry
 * against server-side socket closes; (3) slow stub (2-6s per /query response),
 * 60 requests — real search-service latency; (4) same, with a genuine content
 * edit to src/config/retrieval.ts mid-run to force a Turbopack rebuild of the
 * route mid-flight. Wrap each run with a watchdog setInterval that logs
 * `process.getActiveResourcesInfo()` for any request older than 30s and a
 * hard wall-clock cap so the script self-terminates.
 */

export interface FetchJsonResult {
  status: number
  ok: boolean
  text: string
  json: any
  wallMs: number
}

/** Final-attempt timeout — the signal fired and no retries remain. */
export class HttpTimeoutError extends Error {
  constructor(url: string, timeoutMs: number, attempts: number) {
    super(
      `fetch timeout: ${url} did not complete within ${timeoutMs}ms ` +
        `across ${attempts} attempt(s)`,
    )
    this.name = 'HttpTimeoutError'
  }
}

/** Abort fired (AbortSignal.timeout) at any phase, including body read.
 *
 * Classified by name, not instanceof: Node's DOMException is not an Error
 * subclass, undici wraps some aborts as TypeError with the DOMException in
 * .cause, and Jest's test realm makes cross-realm instanceof checks lie.
 */
function isAbortError(e: unknown): boolean {
  let cur: any = e
  for (let i = 0; i < 3 && cur; i++) {
    if (cur.name === 'TimeoutError' || cur.name === 'AbortError') return true
    cur = cur.cause
  }
  return false
}

/** undici surfaces transport failures (reset socket, DNS, refused) as a
 * TypeError wrapper ("fetch failed") with the real reason in .cause. */
function isNetworkError(e: unknown): boolean {
  return (e as { name?: unknown })?.name === 'TypeError'
}

export async function fetchJson(
  url: string,
  opts: {
    method?: string
    body?: unknown
    headers?: Record<string, string>
    timeoutMs?: number
    retries?: number
  } = {},
): Promise<FetchJsonResult> {
  const {
    method = 'GET',
    body,
    headers,
    timeoutMs = 120_000,
    retries = 1,
  } = opts
  const started = Date.now()
  const finalHeaders =
    body === undefined
      ? headers
      : { 'Content-Type': 'application/json', ...headers }

  for (let attempt = 1; ; attempt++) {
    try {
      // One signal covers dispatch, headers, and the body read below.
      const signal = AbortSignal.timeout(timeoutMs)
      const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      })
      // Inside the signal's coverage — an aborted body read rejects here.
      const text = await res.text()

      let json: any
      try {
        json = text.length > 0 ? JSON.parse(text) : null
      } catch {
        // A protocol answer, not a transport failure — no retry.
        const err = new Error(
          `non-JSON response from ${url}: status ${res.status}, ` +
            `body "${text.slice(0, 200)}"`,
        )
        ;(err as any).status = res.status
        throw err
      }
      return {
        status: res.status,
        ok: res.ok,
        text,
        json,
        wallMs: Date.now() - started,
      }
    } catch (e) {
      const retriable =
        attempt <= retries && (isAbortError(e) || isNetworkError(e))
      if (!retriable) {
        if (isAbortError(e)) throw new HttpTimeoutError(url, timeoutMs, attempt)
        throw e
      }
    }
  }
}
