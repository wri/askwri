/**
 * Capture stage (§3.2): run the selected cases × passes against a target and
 * record everything the judge/score stages consume. Preflight runs first and
 * its report is embedded in the artifact (the pure scorer's only source of
 * corpus attainability); when it fails, the run aborts BEFORE any
 * capture-pass retrieve/answer call.
 */
import { execFileSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { SYS_V1, SYS_V2 } from '@/app/api/answer/route'
import { Controls } from './cli'
import { expectedIdsOf, loadEvalset } from './fixture'
import { fetchJson } from './http'
import { preflight } from './preflight'
import {
  directTarget,
  gatewayTarget,
  RetrievalOutcome,
  TargetClient,
} from './target'
import {
  CaptureArtifact,
  CaseCapture,
  Evalset,
  FixtureCase,
  PassCapture,
  PreflightReport,
  Provenance,
} from './types'

const sha256 = (s: string) =>
  crypto.createHash('sha256').update(s).digest('hex')

/** Prompt hashes keyed by the route's version names — provenance for the
 * synthesis behavior a capture measured. */
const PROMPT_HASHES: Record<string, string> = {
  v1: sha256(SYS_V1),
  v2: sha256(SYS_V2),
}

const REPO_ROOT = path.resolve(__dirname, '..', '..')

/** Default git shim: run git in the harness's worktree. */
const defaultGit = (args: string[]): string =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })

export interface CaptureDeps {
  http: typeof fetchJson
  /** Test seam for provenance; default runs `git` in the harness worktree. */
  git?: (args: string[]) => string
  now?: () => Date
}

/** Preflight failed — the run must not spend any capture-pass call. Carries
 * the report so the CLI can print the failing cases. */
export class PreflightAbortError extends Error {
  constructor(
    public readonly report: PreflightReport,
    message: string,
  ) {
    super(message)
    this.name = 'PreflightAbortError'
  }
}

/** The submodule's pinned commit as recorded in the parent tree; falls back
 * to the submodule's own HEAD (e.g. an uncommitted submodule bump). */
function fixtureCommit(git: (args: string[]) => string): string {
  try {
    return git(['rev-parse', 'HEAD:evaluation/eval-review']).trim()
  } catch {
    return git(['-C', 'evaluation/eval-review', 'rev-parse', 'HEAD']).trim()
  }
}

function buildTarget(ctl: Controls, http: typeof fetchJson): TargetClient {
  return ctl.directSearchUrl
    ? directTarget(ctl.directSearchUrl, ctl.directAnswerUrl!, http)
    : gatewayTarget(ctl.targetUrl, http)
}

function selectCases(evalset: Evalset, ctl: Controls): FixtureCase[] {
  let cases = evalset.test_cases
  if (ctl.only.length > 0) {
    cases = cases.filter((c) => ctl.only.includes(c.id))
  }
  if (ctl.limit !== undefined) {
    cases = cases.slice(0, ctl.limit)
  }
  return cases
}

function abortMessage(evalset: Evalset, report: PreflightReport): string {
  const lines = ['preflight failed — aborting before any capture-pass call:']
  if (!report.corpus_ok) {
    const cases = evalset.test_cases
      .filter((c) =>
        expectedIdsOf(c).some((id) => report.missing_docs.includes(id)),
      )
      .map((c) => c.id)
    lines.push(
      `  corpus: docs missing from the target's catalog: ${report.missing_docs.join(', ')} ` +
        `(cases: ${cases.join(', ')})`,
    )
  }
  if (!report.twins_ok) {
    lines.push(
      "  twins: a twin pair member is missing from the target's catalog",
    )
  }
  if (report.snippet_failures.length > 0) {
    lines.push(`  snippets: ${report.snippet_failures.length} failure(s)`)
    for (const f of report.snippet_failures) {
      lines.push(`    ${f.case_id} / ${f.doc_id}: ${f.reason}`)
    }
  }
  if (!report.synthesis_probe_ok) lines.push('  synthesis probe failed')
  if (!report.judge_probe_ok) lines.push('  judge probe failed')
  return lines.join('\n')
}

const failedAnswer = (error: string): PassCapture['answer'] => ({
  knobs: {},
  passages_sent: [],
  sentences: [],
  cites: [],
  raw_model_json: '',
  low_coverage: false,
  invalid_cites: 0,
  wall_ms: 0,
  error,
})

/** One case × one pass: retrieve, then answer with the retrieval's docs
 * verbatim. A failure records `error` and never throws (run-evalset
 * precedent — one bad case must not sink the run). */
async function runPass(
  c: FixtureCase,
  pass: number,
  ctl: Controls,
  target: TargetClient,
): Promise<{
  capture: PassCapture
  debugKnobs?: { model?: string; base_url?: string }
}> {
  const retStart = Date.now()
  let ret: RetrievalOutcome
  let retWall: number
  try {
    ret = await target.retrieve(c.question, ctl.retrievalKnobs)
    retWall = Date.now() - retStart
  } catch (e) {
    const msg = (e as Error).message
    return {
      capture: {
        pass,
        retrieval: {
          chunks: [],
          likely_off_topic: false,
          service_ms: null,
          cost_usd: null,
          wall_ms: Date.now() - retStart,
          error: msg,
        },
        answer: failedAnswer(`skipped: retrieval failed (${msg})`),
      },
    }
  }

  // AIResearchModal mirror: the retrieval's abstain flag flows into the
  // answer knobs unless the run explicitly overrode it with --knob.
  const knobs: Record<string, unknown> = { ...ctl.synthesisKnobs }
  if (!('likely_off_topic' in knobs))
    knobs.likely_off_topic = ret.likely_off_topic

  const ansStart = Date.now()
  const ans = await target.answer(c.question, ret.docs, knobs)
  const answer: PassCapture['answer'] = {
    knobs,
    passages_sent: ans.passages_sent,
    sentences: ans.synthesis?.sentences ?? [],
    cites: ans.synthesis?.cites ?? [],
    // The route never exposes the model's raw content — its debug block
    // (knobs, invalid_cites, apiResponse, parsing) is the closest shipped
    // signal, preserved verbatim.
    raw_model_json: JSON.stringify(ans.debug ?? {}),
    source_relevance: ans.synthesis?.source_relevance,
    warning: ans.synthesis?.warning,
    low_coverage: ans.synthesis?.warning === 'low_coverage',
    invalid_cites: ans.debug?.invalid_cites ?? 0,
    fallback_reason: ans.debug?.fallbackReason,
    wall_ms: Date.now() - ansStart,
    ...(ans.ok ? {} : { error: ans.error ?? `status ${ans.status}` }),
  }
  return {
    capture: {
      pass,
      retrieval: {
        chunks: ret.chunks,
        likely_off_topic: ret.likely_off_topic,
        service_ms: ret.service_ms,
        cost_usd: ret.cost_usd,
        wall_ms: retWall,
      },
      answer,
    },
    debugKnobs: ans.ok
      ? { model: ans.debug?.knobs?.model, base_url: ans.debug?.knobs?.base_url }
      : undefined,
  }
}

export async function runCapture(
  ctl: Controls,
  deps: CaptureDeps,
): Promise<CaptureArtifact> {
  const git = deps.git ?? defaultGit
  const now = deps.now ?? (() => new Date())
  const evalset = loadEvalset(ctl.evalsetPath)

  // A --only id that matches nothing would silently capture zero cases.
  const unknown = ctl.only.filter(
    (id) => !evalset.test_cases.some((c) => c.id === id),
  )
  if (unknown.length > 0) {
    throw new Error(`--only names unknown case id(s): ${unknown.join(', ')}`)
  }

  const target = buildTarget(ctl, deps.http)
  // Select BEFORE preflight (--only filter, --limit slice): the abort gate
  // and the call estimate must cover exactly the cases this run will
  // capture — a missing doc in a later, unselected case must neither abort
  // a --limit partial run nor inflate the estimate.
  const selected = selectCases(evalset, ctl)
  const report = await preflight({
    evalset: { ...evalset, test_cases: selected },
    target,
    passes: ctl.passes,
  })

  // Abort gate (binding, Task 4 review): a run preflight already knows is
  // unmeasurable must not spend capture-pass calls. `judging` is false here —
  // capture passes no judge config; the clause is kept as written for the
  // composed runs that will.
  const judging = false
  if (
    !report.corpus_ok ||
    !report.twins_ok ||
    report.snippet_failures.length > 0 ||
    !report.synthesis_probe_ok ||
    (judging && !report.judge_probe_ok)
  ) {
    throw new PreflightAbortError(report, abortMessage(evalset, report))
  }

  const health = await target.health()
  const caseCaptures: CaseCapture[] = new Array(selected.length)
  // EFFECTIVE synthesis config: the first successful answer's debug.knobs.
  let effective: { model?: string; base_url?: string } | undefined
  let costTotal = 0
  let costReported = 0

  const runCase = async (index: number, c: FixtureCase): Promise<void> => {
    const passes: PassCapture[] = []
    for (let pass = 0; pass < ctl.passes; pass++) {
      const { capture, debugKnobs } = await runPass(c, pass, ctl, target)
      passes.push(capture)
      if (capture.retrieval.cost_usd != null) {
        costTotal += capture.retrieval.cost_usd
        costReported++
      }
      if (!effective && debugKnobs) effective = debugKnobs
    }
    caseCaptures[index] = { case_id: c.id, fixture_case: c, passes }
  }

  // Sequential when concurrency is 1 (the default); otherwise a simple
  // case-level worker pool. Cases land in fixture order regardless.
  const queue = selected.map((c, i) => [c, i] as const)
  const workerCount = Math.max(1, Math.min(ctl.concurrency, queue.length))
  await Promise.all(
    Array.from({ length: workerCount }, () =>
      (async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          await runCase(next[1], next[0])
        }
      })(),
    ),
  )

  const provenance: Provenance = {
    fixture: {
      path: ctl.evalsetPath,
      name: evalset.name,
      commit: fixtureCommit(git),
    },
    target: {
      mode: target.mode,
      urls: ctl.directSearchUrl
        ? [ctl.directSearchUrl, ctl.directAnswerUrl!]
        : [ctl.targetUrl],
      config: health,
    },
    knobs: {
      retrieval: ctl.retrievalKnobs,
      synthesis: ctl.synthesisKnobs,
    },
    synthesis: {
      model: effective?.model ?? (ctl.synthesisKnobs.model as string) ?? '',
      base_url:
        effective?.base_url ?? (ctl.synthesisKnobs.base_url as string) ?? '',
      prompt_hashes: PROMPT_HASHES,
    },
    passes: ctl.passes,
    harness_sha: git(['rev-parse', 'HEAD']).trim(),
    timestamp: now().toISOString(),
    node_version: process.version,
  }

  if (costReported > 0) {
    console.log(
      `[capture] cost $${costTotal.toFixed(4)} total  ` +
        `$${(costTotal / costReported).toFixed(4)} mean  ` +
        `(${costReported}/${selected.length * ctl.passes} retrieval calls reported usage)`,
    )
  }

  return {
    schema: 'answer-eval/capture@1',
    provenance,
    preflight: report,
    cases: caseCaptures,
  }
}

/** Pretty-printed, stable key order. Returns the written file path. */
export function writeCaptureArtifact(
  artifactsDir: string,
  label: string,
  artifact: CaptureArtifact,
): string {
  fs.mkdirSync(artifactsDir, { recursive: true })
  const file = path.join(artifactsDir, `capture-${label}.json`)
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2) + '\n')
  return file
}
