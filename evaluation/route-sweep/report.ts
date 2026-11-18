/**
 * Report stage: turns a sweep artifact into the readout a person reads — the
 * markdown side-by-side, and the path its JSON twin is written to.
 *
 * Two rules shape this module. The mechanical summary comes first, before any
 * model output, because the first question a reader has is "is this run broken",
 * and that is answerable without reading a word of prose. And a row that is not
 * evidence says so where the row is, because two strings stacked side by side
 * read as agreement unless one of them is labelled otherwise.
 *
 * Rendering is pure: the artifact goes in, a string comes out. No I/O, no clock,
 * no env — the CLI owns the date and the file writes, so a report can be
 * regenerated from a stored artifact without touching the live target.
 */
import { checkCall, inputCount } from './checks'
import type { CallResult, RouteName, SweepArtifact } from './types'
import { MODELS, type ModelId } from '@/config/models'

/** The order a reader expects the routes in, matching the sweep's own. */
const ROUTE_ORDER: RouteName[] = [
  'batch-why',
  'batch-relates',
  'alignment',
  'translate',
]

/** The caveat shown on a row the route's sanitizer rewrote. Not a failure —
 * a model did answer — but some of the text underneath is not its own. */
const SANITIZED_MARKER = 'sanitized: some text was substituted'

/** The field carrying the human-visible text, per route — the same shapes
 * `checkCall` reads, named here so a missing one can say which. */
const OUTPUT_FIELD: Record<RouteName, string> = {
  'batch-why': 'explanations[].why',
  'batch-relates': 'results[].relates',
  alignment: 'assessment.insights[]',
  translate: 'translation',
}

/**
 * The route's human-visible output, as lines. Deliberately not the whole
 * response: a reader compares the sentences a user would see, and the raw
 * payload is in the artifact for anyone who wants it.
 */
function renderOutputs(route: RouteName, response: unknown): string[] {
  const body = (response ?? {}) as any
  switch (route) {
    case 'batch-why':
      return Array.isArray(body.explanations)
        ? body.explanations.map((e: any) => String(e?.why ?? ''))
        : []
    case 'batch-relates':
      return Array.isArray(body.results)
        ? body.results.map((r: any) => String(r?.relates ?? ''))
        : []
    case 'alignment':
      return Array.isArray(body.assessment?.insights)
        ? body.assessment.insights.map((t: unknown) => String(t ?? ''))
        : []
    case 'translate':
      return typeof body.translation === 'string' ? [body.translation] : []
  }
}

/**
 * Why a row is not evidence, in words a reader can act on, or null when the
 * model produced the text. The verdict itself comes from `checkCall`; this only
 * labels the output shown underneath it, since the canned-string failure modes
 * answer 200 with plausible text.
 *
 * `sanitized` is deliberately not decided here: a sanitized call did produce
 * text, so it passes the check, and the caveat rides on the model's own line
 * (`SANITIZED_MARKER`) rather than turning a pass into a failure.
 */
function notEvidence(r: CallResult): string | null {
  if (r.error) return `call failed: ${r.error}`
  const p = r.provenance
  if (!p) return 'no provenance, so the model that wrote this is unknown'
  if (p.produced !== true) {
    return (
      'the route answered with substituted text, not a model output' +
      (p.fallback_reason ? ` (fallback_reason: ${p.fallback_reason})` : '')
    )
  }
  return null
}

function modelRank(models: [string, string], model: string): number {
  const at = models.indexOf(model)
  // An unlisted model sorts after both, so a row that does not belong to the
  // pair is shown rather than dropped.
  return at === -1 ? models.length : at
}

/**
 * The case's question, taken from the payload the call was sent with. Shown
 * wherever the payload carries it — it is what makes two models' outputs
 * comparable at all — but translate's payload carries a snippet rather than
 * the query, and there the readout says the id alone rather than inventing one.
 */
function questionOf(call: CallResult): string | null {
  const query = (call.request as { query?: unknown } | null)?.query
  return typeof query === 'string' && query ? query : null
}

/** Cases the artifact's roster knows about that produced no calls at all.
 * `doc_count === 0` and "stopped early" are kept apart: the first is a corpus
 * gap, the second a sweep that did not get that far. */
function skippedLines(a: SweepArtifact): string[] {
  if (!a.cases) return []
  const called = new Set(a.calls.map((c) => c.case_id))
  const rows = a.cases
    .filter((c) => !called.has(c.id))
    .map(
      (c) =>
        `- ${c.id}: ${c.question} — not run (${
          c.doc_count === 0 ? 'no documents' : 'no calls recorded'
        })`,
    )
  return rows.length ? ['Cases with no calls:', ...rows] : []
}

function headerLines(a: SweepArtifact, failedCount: number): string[] {
  const facts = [
    `- target: ${a.target}`,
    // Only when the documents came from somewhere else: a line repeating the
    // target on every run would be noise, and its absence is what says the two
    // commands named one host.
    a.frozen_target && a.frozen_target !== a.target
      ? `- documents frozen at: ${a.frozen_target}`
      : null,
    `- models: ${a.models[0]} vs ${a.models[1]}`,
    `- max_results: ${a.max_results}`,
    `- submodule commit: ${a.submodule_commit}`,
    // The frozen set is gitignored, so these two lines are the only record a
    // committed baseline carries of which cases it ran and whether they were
    // reviewed.
    a.evalset ? `- evalset: ${a.evalset}` : null,
    a.evalset_note ? `- evalset note: ${a.evalset_note}` : null,
    // `unknown` sits in this line, not in a footnote: a sweep that cannot say
    // which build answered must never read as a check on a deployed change.
    `- code version: ${a.code_version ?? 'unknown'}`,
    a.calls.length === 0
      ? '- checks: no calls recorded'
      : `- checks: ${failedCount} of ${a.calls.length} calls failed`,
  ].filter((line): line is string => line !== null)

  return [
    `# Route model sweep: ${a.label}`,
    '',
    ...facts,
    '',
    // The spec requires the readout to state this: every case in the pinned set
    // is non-English, so a clean run says nothing about English input.
    'No English control case: every case is non-English, so a regression that ' +
      'appears only on English input would not show here.',
    '',
  ]
}

type Verdict = { call: CallResult; ok: boolean; failures: string[] }

/**
 * One call's mechanical verdict. `checkCall` is invoked here and by the CLI's
 * console summary, so neither side derives the two arguments that matter for
 * itself: the expected model is the one the call requested (the sweep records
 * it from the job), and the input count comes from `inputCount` in `checks.ts`,
 * which owns that rule for both callers.
 */
function verdictOf(call: CallResult): Verdict {
  const check = checkCall(
    call,
    call.model,
    inputCount(call.route, call.request),
  )
  return { call, ok: check.ok, failures: check.failures }
}

function mechanicalLines(a: SweepArtifact, failed: Verdict[]): string[] {
  const lines = ['## Mechanical checks', '']

  if (a.calls.length === 0) {
    lines.push('No calls recorded: this artifact is evidence of nothing.')
  } else if (failed.length === 0) {
    lines.push(`All ${a.calls.length} calls passed the mechanical checks.`)
  } else {
    lines.push('Failed calls:')
    for (const f of failed) {
      lines.push(
        `- ${f.call.route} / ${f.call.case_id} / ${f.call.model}: ${f.failures.join('; ')}`,
      )
    }
  }

  if (!a.code_version) {
    lines.push(
      '',
      'Code version unknown: nothing in this artifact proves which build answered, so no row here can evidence a deployed change.',
    )
  }

  const skipped = skippedLines(a)
  if (skipped.length) lines.push('', ...skipped)

  lines.push('')
  return lines
}

function caseLines(
  a: SweepArtifact,
  route: RouteName,
  caseId: string,
  calls: CallResult[],
): string[] {
  const roster = a.cases?.find((c) => c.id === caseId)
  const question = roster?.question ?? questionOf(calls[0])
  const lines = [question ? `### ${caseId}: ${question}` : `### ${caseId}`, '']

  // The verdict sits on one line above both outputs: pass/fail per call, with
  // `checkCall`'s own wording, so the reader never has to work out whether the
  // two strings below are comparable.
  const verdicts = calls.map(verdictOf)
  lines.push(
    `**check:** ${verdicts
      .map((v) =>
        v.ok
          ? `✓ ${v.call.model}`
          : `✗ ${v.call.model} — ${v.failures.join('; ')}`,
      )
      .join(' · ')}`,
  )

  for (const call of calls) {
    const reason = notEvidence(call)
    // `alignment`'s sanitizer and the batch routes' padding answer with text the
    // model did not write while still reporting `produced: true`, so without
    // this the substituted sentence reads as model prose under a ✓.
    const notes = [
      reason ? `NOT EVIDENCE: ${reason}` : null,
      call.provenance?.sanitized === true ? SANITIZED_MARKER : null,
    ].filter((note): note is string => note !== null)
    const heading = `**${call.model}** (${call.latency_ms} ms)`
    lines.push('', notes.length ? `${heading} — ${notes.join(' — ')}` : heading)
    const outputs = renderOutputs(route, call.response)
    if (!call.error) {
      // A call that never returned says so on its own line above; adding "the
      // response has no X" would blame the route's shape for a dead call.
      if (outputs.length === 0) {
        lines.push(
          `_(nothing to show: the response has no ${OUTPUT_FIELD[route]})_`,
        )
      } else if (route === 'translate') {
        lines.push(`> ${outputs[0]}`)
      } else {
        outputs.forEach((text, i) => {
          lines.push(`${i + 1}. ${text.trim() === '' ? '_(empty)_' : text}`)
        })
      }
    }
  }

  lines.push('')
  return lines
}

function routeLines(a: SweepArtifact, route: RouteName): string[] {
  const calls = a.calls.filter((c) => c.route === route)
  if (calls.length === 0) return []

  const caseIds: string[] = []
  for (const call of calls) {
    if (!caseIds.includes(call.case_id)) caseIds.push(call.case_id)
  }

  const lines = ['', `## ${route}`, '']
  for (const caseId of caseIds) {
    const group = calls
      .filter((c) => c.case_id === caseId)
      .sort(
        (x, y) => modelRank(a.models, x.model) - modelRank(a.models, y.model),
      )
    lines.push(...caseLines(a, route, caseId, group))
  }
  return lines
}

/* ---------------- the acceptance numbers ---------------- */

/** What the provider billed for one call. Every attempt counts: alignment reports
 *  one usage per try inside `debug.tries[]` and pays for the ones that failed, so
 *  costing only the attempt that parsed understates the spend. `translate`
 *  reports none, and a route with no usage gets a null cost rather than a zero. */
function billedTokens(
  call: CallResult,
): Array<{ input: number; output: number }> | null {
  const body = call.response as any
  if (!body || typeof body !== 'object') return null
  const one = (u: any) => {
    const input = u?.prompt_tokens ?? u?.input_tokens
    const output = u?.completion_tokens ?? u?.output_tokens
    return typeof input === 'number' &&
      typeof output === 'number' &&
      Number.isFinite(input) &&
      Number.isFinite(output) &&
      input >= 0 &&
      output >= 0
      ? { input, output }
      : null
  }
  const tries = Array.isArray(body.debug?.tries) ? body.debug.tries : []
  if (tries.length) {
    const tokens: Array<{ input: number; output: number }> = []
    for (const attempt of tries) {
      const usage = one(attempt?.usage)
      if (!usage) return null
      tokens.push(usage)
    }
    return tokens
  }
  const usage = one(body.usage)
  return usage ? [usage] : null
}

/** Keyed on the model the call ASKED for, not on `usage.model`: alignment echoes
 *  `openai/<id>` and a lookup on that would silently price another model. */
function priceOf(model: string) {
  return Object.prototype.hasOwnProperty.call(MODELS, model)
    ? MODELS[model as ModelId].price
    : undefined
}

export type RouteSummary = {
  route: RouteName
  model: string
  calls: number
  failed: number
  /** Nearest-rank p95; null only when there were no calls at all. */
  p95Ms: number | null
  /** Null when any call/attempt lacks complete usage, or there is no price. */
  costUsd: number | null
}

/**
 * The bar asks for p95 and cost per job. Nothing else in this tool computes
 * either, and a number derived from the wrong model or the wrong attempt is
 * worse than no number.
 */
export function summarise(a: SweepArtifact): RouteSummary[] {
  const rows: RouteSummary[] = []
  for (const route of ROUTE_ORDER) {
    for (const model of a.models) {
      const calls = a.calls.filter(
        (c) => c.route === route && c.model === model,
      )
      if (!calls.length) continue
      const failed = calls.filter(
        (c) => !checkCall(c, model, inputCount(route, c.request)).ok,
      ).length
      const latencies = calls.map((c) => c.latency_ms).sort((x, y) => x - y)
      const price = priceOf(model)
      const usages = calls.map(billedTokens)
      const billable = usages.flatMap((usage) => usage ?? [])
      const costUsd =
        price && usages.every((usage) => usage !== null) && billable.length
          ? +billable
              .reduce(
                (sum, t) =>
                  sum +
                  (t.input / 1_000_000) * price.inputPer1M +
                  (t.output / 1_000_000) * price.outputPer1M,
                0,
              )
              .toFixed(6)
          : null
      rows.push({
        route,
        model,
        calls: calls.length,
        failed,
        // Nearest rank: the smallest sample at or above the 95th percentile.
        p95Ms: latencies[Math.ceil(0.95 * latencies.length) - 1] ?? null,
        costUsd,
      })
    }
  }
  return rows
}

/** The bar's cost clauses, as arithmetic: every row must be measured, and a
 *  candidate must not cost more than 20% above the incumbent it replaces. A clean
 *  mechanical run says nothing about either — a translate sweep can print "cost
 *  unmeasured" over zero failed checks (whole-branch review, finding 6).
 *
 *  Latency is NOT gated here: the artifact records whole-call time while each
 *  route scales and clamps its own deadline per prompt, so no denominator in this
 *  file is the clock the call ran against. Printing the p95 and its n is honest;
 *  inventing a ratio would not be. */
export function acceptanceGate(a: SweepArtifact): {
  ok: boolean
  reasons: string[]
} {
  const reasons: string[] = []
  const rows = summarise(a)
  // Nothing measured is not a passed bar (gpt-6-luna review).
  if (!rows.length) {
    return {
      ok: false,
      reasons: ['no calls in this artifact: nothing to gate'],
    }
  }
  // A pair with no calls never becomes a row, so the loops below would skip it and
  // report the clause as met (roborev job 931). Any route that ran at all must have
  // run both models, or there is nothing to compare.
  for (const route of new Set(rows.map((r) => r.route))) {
    for (const model of a.models) {
      if (!rows.some((r) => r.route === route && r.model === model)) {
        reasons.push(
          `no calls for ${route} / ${model}: the pair cannot be compared`,
        )
      }
    }
  }
  for (const row of rows) {
    if (row.costUsd === null) {
      reasons.push(
        `cost unmeasured for ${row.route} / ${row.model}: the bar needs it within 20% of the incumbent`,
      )
    }
  }
  for (const route of ROUTE_ORDER) {
    const mine = rows.filter((r) => r.route === route)
    const [a1, b1] = mine
    if (!a1 || !b1 || a1.costUsd === null || b1.costUsd === null) continue
    if (a1.costUsd === 0) {
      // "Within 20% of the incumbent's" cannot be computed against zero, and a
      // skipped clause reads as a met one — including when both sides are zero,
      // which means the sweep measured no tokens at all (jobs 932, gpt-6-luna).
      reasons.push(
        `incumbent cost is zero on ${route}, so the 20% bar cannot be computed`,
      )
      continue
    }
    const pct = ((b1.costUsd - a1.costUsd) / a1.costUsd) * 100
    // One-sided: a saving is not a regression, and the incumbent is being
    // retired, so only a candidate more than 20% dearer fails.
    if (pct > 20) {
      reasons.push(
        `${b1.model} is +${pct.toFixed(1)}% vs ${a1.model} on ${route}: the bar allows +20%`,
      )
    }
  }
  return { ok: reasons.length === 0, reasons }
}

/** One line per route and model, with n beside every percentile: ten cases is an
 *  observation with a wide interval, and a percentile printed without its count
 *  reads as a baseline. */
function acceptanceLines(a: SweepArtifact): string[] {
  const rows = summarise(a)
  if (!rows.length) return []
  const lines = ['## Acceptance numbers', '']
  for (const route of ROUTE_ORDER) {
    const mine = rows.filter((r) => r.route === route)
    if (!mine.length) continue
    lines.push(`### ${route}`)
    for (const r of mine) {
      const cost = r.costUsd === null ? 'cost unmeasured' : `cost $${r.costUsd}`
      lines.push(
        // Plain, not bold: the case rows above already head a line with
        // `**model**`, and a second one makes every "the row for this model"
        // reader pick the wrong line.
        `- ${r.model} — calls ${r.calls}, failed ${r.failed}, ` +
          `p95 ${r.p95Ms ?? '–'} ms (n=${r.calls}), ${cost}`,
      )
    }
    const [first, second] = mine
    // Latency first: reported as a delta, not gated, because the spec's clause
    // (p95 under 60% of the job's deadline) has no honest denominator here.
    if (first?.p95Ms && second?.p95Ms) {
      const lat = ((second.p95Ms - first.p95Ms) / first.p95Ms) * 100
      lines.push(
        `- p95 of ${second.model} vs ${first.model}: ${lat >= 0 ? '+' : ''}${lat.toFixed(1)}% (${first.p95Ms} ms to ${second.p95Ms} ms)`,
      )
    }
    if (first?.costUsd && second?.costUsd) {
      const pct = ((second.costUsd - first.costUsd) / first.costUsd) * 100
      lines.push(
        `- cost of ${second.model} vs ${first.model}: ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`,
      )
    }
    lines.push('')
  }
  return lines
}

/** The whole readout. Pure: same artifact in, same markdown out. */
export function renderMarkdown(a: SweepArtifact): string {
  const verdicts = a.calls.map(verdictOf)
  const failed = verdicts.filter((v) => !v.ok)

  const lines = [
    ...headerLines(a, failed.length),
    ...mechanicalLines(a, failed),
    ...acceptanceLines(a),
  ]
  for (const route of ROUTE_ORDER) lines.push(...routeLines(a, route))
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  )
}

/**
 * Where this run's two files go: beside the other baselines, named for the day
 * it ran and the label the operator chose, since an artifact filename is the
 * only thing distinguishing two runs a week apart.
 *
 * The local date on purpose — the operator names the run by the day they made
 * it, not by UTC.
 */
export function artifactPath(
  label: string,
  date: Date = new Date(),
): { json: string; md: string } {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const base = `evaluation/baselines/${yyyy}-${mm}-${dd}-route-sweep-${label}`
  return { json: `${base}.json`, md: `${base}.md` }
}
