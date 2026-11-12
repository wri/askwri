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
import { checkCall } from './checks'
import type { CallResult, RouteName, SweepArtifact } from './types'

/** The order a reader expects the routes in, matching the sweep's own. */
const ROUTE_ORDER: RouteName[] = [
  'batch-why',
  'batch-relates',
  'alignment',
  'translate',
]

/** The field carrying the human-visible text, per route — the same shapes
 * `checkCall` reads, named here so a missing one can say which. */
const OUTPUT_FIELD: Record<RouteName, string> = {
  'batch-why': 'explanations[].why',
  'batch-relates': 'results[].relates',
  alignment: 'assessment.insights[]',
  translate: 'translation',
}

/**
 * How many outputs the response had to contain: the payload's array length for
 * the array routes, 1 for the single-output ones. Read from the request, never
 * from the response — a response cannot say how many inputs it dropped.
 *
 * An unreadable array counts as 0, which `checkCall` reports as a failure; the
 * alternative would be to skip the length check on exactly the malformed
 * payloads it exists to catch.
 */
function inputCount(route: RouteName, request: unknown): number {
  if (route === 'translate' || route === 'alignment') return 1
  const field = route === 'batch-why' ? 'passages' : 'docs'
  const list = (request as Record<string, unknown> | null)?.[field]
  return Array.isArray(list) ? list.length : 0
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
  return [
    `# Route model sweep: ${a.label}`,
    '',
    `- target: ${a.target}`,
    `- models: ${a.models[0]} vs ${a.models[1]}`,
    `- max_results: ${a.max_results}`,
    `- submodule commit: ${a.submodule_commit}`,
    // `unknown` sits in this line, not in a footnote: a sweep that cannot say
    // which build answered must never read as a check on a deployed change.
    `- code version: ${a.code_version ?? 'unknown'}`,
    a.calls.length === 0
      ? '- checks: no calls recorded'
      : `- checks: ${failedCount} of ${a.calls.length} calls failed`,
    '',
  ]
}

type Verdict = { call: CallResult; ok: boolean; failures: string[] }

/**
 * One call's mechanical verdict. The only place `checkCall` is invoked, because
 * the expected model and the input count are exactly the two arguments a second
 * caller would get subtly wrong: the model is the one the call requested (the
 * sweep records it from the job), and the input count comes from the request.
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
    lines.push(
      '',
      `**${call.model}** (${call.latency_ms} ms)${
        reason ? ` — NOT EVIDENCE: ${reason}` : ''
      }`,
    )
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

/** The whole readout. Pure: same artifact in, same markdown out. */
export function renderMarkdown(a: SweepArtifact): string {
  const verdicts = a.calls.map(verdictOf)
  const failed = verdicts.filter((v) => !v.ok)

  const lines = [
    ...headerLines(a, failed.length),
    ...mechanicalLines(a, failed),
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
