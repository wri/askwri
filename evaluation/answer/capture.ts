/**
 * Capture stage (§3.2): run the selected cases × passes against a target and
 * record everything the judge/score stages consume. Preflight runs first and
 * its report is embedded in the artifact (the pure scorer's only source of
 * corpus attainability); when it fails, the run aborts BEFORE any
 * capture-pass retrieve/answer call. The partial artifact is checkpointed
 * after every case so an unexpected throw mid-run cannot discard the paid
 * captures around it.
 */
import { execFileSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { SYS_V1, SYS_V2 } from '@/app/api/answer/route'
import { Controls } from './cli'
import { captureFingerprint } from './fingerprint'
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

/** Route fallbacks that mean the provider never produced an answer. The pass
 * is recorded with its canned text but marked as an error so the judge
 * spends nothing on it and the scorer excludes it — a provider outage must
 * read as excluded passes, not as a synthesis regression. `no_valid_sentences`
 * is deliberately absent: the model answered and its answer was unusable,
 * which IS synthesis quality. */
const INFRA_FALLBACKS = new Set(['no_api_key', 'api_error', 'exception'])

const REPO_ROOT = path.resolve(__dirname, '..', '..')

/** Default git shim: run git in the harness's worktree. */
const defaultGit = (args: string[]): string =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })

export interface CaptureDeps {
  http: typeof fetchJson
  /** Test seam for provenance; default runs `git` in the harness worktree. */
  git?: (args: string[]) => string
  now?: () => Date
  /** Called with the partial artifact after every completed case. */
  checkpoint?: (partial: CaptureArtifact) => void
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

/** HEAD sha, suffixed `-dirty` when the tree has uncommitted changes — a
 * capture from a dirty tree is not reproducible from its recorded sha. */
function harnessSha(git: (args: string[]) => string): string {
  const sha = git(['rev-parse', 'HEAD']).trim()
  const dirty = git(['status', '--porcelain']).trim().length > 0
  return dirty ? `${sha}-dirty` : sha
}

function buildTarget(ctl: Controls, http: typeof fetchJson): TargetClient {
  const opts = { answerTimeoutMs: ctl.timeoutMs }
  return ctl.directSearchUrl
    ? directTarget(ctl.directSearchUrl, ctl.directAnswerUrl!, http, opts)
    : gatewayTarget(ctl.targetUrl, http, opts)
}

function selectCases(evalset: Evalset, ctl: Controls): FixtureCase[] {
  let cases = evalset.test_cases
  if (ctl.only.length > 0) {
    cases = cases.filter((c) => ctl.only.includes(c.id))
  }
  if (ctl.skip.length > 0) {
    cases = cases.filter((c) => !ctl.skip.includes(c.id))
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
        `(cases: ${cases.join(', ')}) — drop them for this run with --skip <case>`,
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
  // Transport-level throw (timeout, network error) mirrors the retrieval
  // guard: record `answer.error`, keep the run alive — a dead socket mid-run
  // must not discard the paid capture data around it.
  let ans: Awaited<ReturnType<TargetClient['answer']>>
  try {
    ans = await target.answer(c.question, ret.docs, knobs)
  } catch (e) {
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
        answer: {
          ...failedAnswer(`answer call failed: ${(e as Error).message}`),
          wall_ms: Date.now() - ansStart,
        },
      },
    }
  }
  const fallback: string | undefined = ans.debug?.fallbackReason
  const error = !ans.ok
    ? (ans.error ?? `status ${ans.status}`)
    : INFRA_FALLBACKS.has(fallback ?? '')
      ? `synthesis fallback: ${fallback}`
      : undefined
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
    fallback_reason: fallback,
    wall_ms: Date.now() - ansStart,
    ...(error ? { error } : {}),
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
    // A fallback pass never defines the EFFECTIVE synthesis config.
    debugKnobs:
      ans.ok && !error
        ? {
            model: ans.debug?.knobs?.model,
            base_url: ans.debug?.knobs?.base_url,
          }
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

  // A --only/--skip id that matches nothing would silently do nothing.
  for (const [flag, ids] of [
    ['--only', ctl.only],
    ['--skip', ctl.skip],
  ] as const) {
    const unknown = ids.filter(
      (id) => !evalset.test_cases.some((c) => c.id === id),
    )
    if (unknown.length > 0) {
      throw new Error(`${flag} names unknown case id(s): ${unknown.join(', ')}`)
    }
  }

  const target = buildTarget(ctl, deps.http)
  // Select BEFORE preflight (--only/--skip filter, --limit slice): the abort
  // gate and the call estimate must cover exactly the cases this run will
  // capture — a missing doc in a later, unselected case must neither abort
  // a --limit partial run nor inflate the estimate.
  const selected = selectCases(evalset, ctl)
  const report = await preflight({
    evalset: { ...evalset, test_cases: selected },
    target,
    passes: ctl.passes,
    synthesisKnobs: ctl.synthesisKnobs,
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
  // Provenance is assembled up front so every checkpoint carries it; the
  // EFFECTIVE synthesis model/base_url (the first successful answer's
  // debug.knobs) is patched in as soon as it is known.
  const provenance: Provenance = {
    fixture: {
      // Absolute: a cwd-relative path would not survive run-score/compare
      // being invoked from another directory.
      path: path.resolve(ctl.evalsetPath),
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
      model: (ctl.synthesisKnobs.model as string) ?? '',
      base_url: (ctl.synthesisKnobs.base_url as string) ?? '',
      prompt_hashes: PROMPT_HASHES,
    },
    passes: ctl.passes,
    harness_sha: harnessSha(git),
    timestamp: now().toISOString(),
    node_version: process.version,
  }

  const caseCaptures: Array<CaseCapture | undefined> = new Array(
    selected.length,
  )
  const artifact = (): CaptureArtifact => {
    const cases = caseCaptures.filter((c): c is CaseCapture => c !== undefined)
    return {
      schema: 'answer-eval/capture@1',
      provenance,
      preflight: report,
      cases,
      capture_fingerprint: captureFingerprint({ cases }),
    }
  }

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
      if (!effective && debugKnobs) {
        effective = debugKnobs
        if (effective.model) provenance.synthesis.model = effective.model
        if (effective.base_url)
          provenance.synthesis.base_url = effective.base_url
      }
    }
    caseCaptures[index] = { case_id: c.id, fixture_case: c, passes }
    deps.checkpoint?.(artifact())
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

  if (costReported > 0) {
    console.log(
      `[capture] cost $${costTotal.toFixed(4)} total  ` +
        `$${(costTotal / costReported).toFixed(4)} mean  ` +
        `(${costReported}/${selected.length * ctl.passes} retrieval calls reported usage)`,
    )
  }

  return artifact()
}

/** Pretty-printed, stable key order, temp-file + rename so a reader (or a
 * checkpoint interrupted mid-write) never sees a torn file. Returns the
 * written file path. */
export function writeCaptureArtifact(
  artifactsDir: string,
  label: string,
  artifact: CaptureArtifact,
): string {
  fs.mkdirSync(artifactsDir, { recursive: true })
  const file = path.join(artifactsDir, `capture-${label}.json`)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(artifact, null, 2) + '\n')
  fs.renameSync(tmp, file)
  return file
}
