/**
 * Route model sweep: one command over the stages in `evaluation/route-sweep/`.
 *
 * Two stages, not one, because the frozen retrieval is the expensive and
 * reusable half: `freeze` records one cite retrieval per case at the target,
 * `sweep` replays that same set through every route at two models. `all` (the
 * default) runs both, since the common case is one command; the split exists
 * for the thing this tool is for — reading a second model pair against the
 * documents the first pair already ran on.
 *
 * The tool reports and does not judge. It says which calls are evidence and
 * writes the two outputs for a person to read; it never picks a winner.
 *
 * Usage:
 *   npm run eval:routes -- --label smoke --model-a gpt-5.4-nano --model-b gpt-5.6-luna
 *   npm run eval:routes -- --stage freeze --label smoke --model-a … --model-b …
 *   npm run eval:routes -- --stage sweep  --label smoke --model-a … --model-b …
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { checkCall, inputCount } from './route-sweep/checks'
import { freezeCases, loadEvalset } from './route-sweep/freeze'
import type { LoadedEvalset } from './route-sweep/freeze'
import { fetchCatalogIndex } from './route-sweep/payloads'
import { artifactPath, renderMarkdown } from './route-sweep/report'
import { resolveCodeVersion, runSweep } from './route-sweep/sweep'
import type {
  CallResult,
  FrozenSet,
  RouteName,
  SweepArtifact,
} from './route-sweep/types'

/** The gateway a sweep runs against unless `--target` says otherwise. It is also
 * the only instance whose running image this tool knows how to look up. */
const QA_TARGET = 'https://qa.askwri-app.org'

/** QA's ECS task, for the image digest in the artifact header
 * (`terraform/infrastructure/ecs.tf`: cluster and service are both
 * `${project_name}-${environment}-…`, project `askwri-app`, environment `qa`). */
const QA_ECS = {
  service: 'askwri-app-qa-service',
  cluster: 'askwri-app-qa-cluster',
  region: 'us-east-2',
}

/** The evalsets live in this submodule; a bare `--evalset name` resolves here. */
const EVALSET_DIR = 'evaluation/eval-review/evalsets'
const DEFAULT_EVALSET = 'evalset_answer_02.json'

/** What the UI's cite call sends (`src/lib/llamaindex-client.ts`), and the input
 * size for three of the four route payloads — recorded in the frozen set rather
 * than assumed downstream. */
const MAX_RESULTS = 40

/** The ALB's `idle_timeout` (`terraform/infrastructure/alb.tf:12`). A longer
 * per-call deadline cannot buy a longer wait: the load balancer drops the
 * connection first, and the sweep would record a client timeout that is
 * indistinguishable from a dead model. */
const MAX_TIMEOUT_MS = 300_000

/** The four routes with no evaluation before this tool, in readout order. */
const ROUTES: RouteName[] = [
  'batch-why',
  'batch-relates',
  'alignment',
  'translate',
]

/** One message, two places that can hit it: the parser (before anything is
 * spent) and the sweep (when the fleet is built from a parsed command line). */
const TOKEN_REQUIRED =
  'a token is required to sweep: pass --token or set EVAL_MODEL_OVERRIDE_TOKEN'

export type SweepOptions = {
  stage: 'freeze' | 'sweep' | 'all'
  label: string
  evalset: string
  /** The exact cases to run, from `--ids`; `--limit` caps how many when both
   * are given. */
  ids?: string[]
  limit: number
  models: [string, string]
  target: string
  concurrency: number
  timeoutMs: number
  token?: string
}

/** Every flag this parser reads. Anything else beginning with `--` is refused
 * rather than skipped: an ignored token falls back to a default, and the default
 * for `--stage` is `all`, which refetches and overwrites the frozen set an
 * operator who mistyped `--stage sweep` meant to replay. */
const KNOWN_FLAGS = new Set([
  '--stage',
  '--label',
  '--evalset',
  '--ids',
  '--limit',
  '--model-a',
  '--model-b',
  '--concurrency',
  '--timeout-ms',
  '--target',
  '--token',
])

/**
 * Parses and validates the command line. Every rule that would otherwise be
 * discovered mid-run is enforced here, so a run that costs money on the shared
 * key fails before the first paid call rather than after it.
 *
 * The token is required for `sweep` and `all` but not for `freeze`: a freeze
 * sends no override, and refusing it for a missing token would be wrong.
 */
export function parseSweepArgs(argv: string[]): SweepOptions {
  for (const token of argv) {
    if (token.startsWith('--') && !KNOWN_FLAGS.has(token)) {
      throw new Error(
        `unknown flag ${token}: known flags are ${[...KNOWN_FLAGS].join(', ')}`,
      )
    }
  }

  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name)
    if (at === -1) return undefined
    const value = argv[at + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${name} needs a value`)
    }
    return value
  }
  const count = (name: string, fallback: number): number => {
    const raw = flag(name)
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer, got ${raw}`)
    }
    return value
  }

  const stage = flag('--stage') ?? 'all'
  if (stage !== 'freeze' && stage !== 'sweep' && stage !== 'all') {
    throw new Error(`--stage must be freeze, sweep or all, got ${stage}`)
  }

  // The label reaches two filenames, and nothing downstream sanitizes it.
  const label = flag('--label')
  if (!label) {
    throw new Error(
      '--label is required: it names both output files, and an anonymous run cannot be told from the next one',
    )
  }
  if (!/^[A-Za-z0-9._-]+$/.test(label)) {
    throw new Error(
      `--label ${label} may hold only letters, digits, dot, dash and underscore: it becomes a filename`,
    )
  }

  const modelA = flag('--model-a')?.trim()
  const modelB = flag('--model-b')?.trim()
  if (!modelA || !modelB) {
    throw new Error(
      `both models are required, and ${!modelA ? '--model-a' : '--model-b'} is missing: ` +
        'neither side can be defaulted, because the point of the sweep is that they differ',
    )
  }
  if (modelA === modelB) {
    throw new Error(
      `--model-a and --model-b are both ${modelA}: the tool never compares a model with itself`,
    )
  }

  const timeoutMs = count('--timeout-ms', 120_000)
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `--timeout-ms ${timeoutMs} exceeds ${MAX_TIMEOUT_MS}: that is the ALB idle_timeout, ` +
        'so a longer deadline only turns every slow call into a client timeout ' +
        'indistinguishable from a dead model',
    )
  }

  const token =
    flag('--token') || process.env.EVAL_MODEL_OVERRIDE_TOKEN || undefined
  if (!token && stage !== 'freeze') {
    throw new Error(
      `${TOKEN_REQUIRED}. Without it every override is refused with a 400 and no row could measure a model`,
    )
  }

  const ids = caseIds(flag('--ids'))

  return {
    stage,
    label,
    evalset: flag('--evalset') ?? DEFAULT_EVALSET,
    ids,
    // Naming cases with `--ids` replaces the first-N selection, so the default
    // ten must not silently cut a longer named list down to ten.
    limit: count('--limit', ids ? ids.length : 10),
    models: [modelA, modelB],
    // Trailing slashes would double up in every URL built from the target.
    target: (flag('--target') ?? QA_TARGET).replace(/\/+$/, ''),
    concurrency: count('--concurrency', 2),
    timeoutMs,
    token,
  }
}

/** `--ids a,b,c`: the exact cases to run. Surrounding spaces are dropped so a
 * comma-separated list can be read at a glance. */
function caseIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')
  if (ids.length === 0) {
    throw new Error('--ids needs at least one case id, comma-separated')
  }
  return ids
}

/** The frozen set is an input to the sweep, not a published artifact, so it
 * lives in the results dir and is named for the run it belongs to. */
export function frozenSetPath(label: string): string {
  return `evaluation/results/route-freeze-${label}.json`
}

/** A bare evalset name resolves inside the submodule; anything with a path
 * separator is taken as given, so a temporary set can be run by path. */
export function evalsetPath(evalset: string): string {
  if (evalset.includes('/')) return evalset
  return join(
    EVALSET_DIR,
    evalset.endsWith('.json') ? evalset : `${evalset}.json`,
  )
}

/** The cases a run selects from `--evalset`, `--ids` and `--limit`, split out
 * so the selection rule is exercised without paying for a freeze. */
export function selectCases(
  opts: Pick<SweepOptions, 'evalset' | 'ids' | 'limit'>,
): LoadedEvalset {
  return loadEvalset(evalsetPath(opts.evalset), {
    limit: opts.limit,
    ids: opts.ids,
  })
}

/**
 * The frozen set's note about how its cases were chosen. The pinned set has no
 * reviewed tier, and a reader must not believe these cases were reviewed. The
 * wording follows what the selection actually was: `--ids` can name a subset
 * that is not a prefix of the file, so "the first N in file order" is false for
 * it and must not be written into the artifact this tool exists to make
 * trustworthy.
 */
export function freezeNote(
  evalset: string,
  loaded: LoadedEvalset,
  ids?: string[],
): string | undefined {
  if (loaded.expert_approved_only) return undefined
  const count = loaded.cases.length
  const selection = ids
    ? `the ${count} case${count === 1 ? '' : 's'} named by --ids ` +
      `${count === 1 ? 'was' : 'were'} used`
    : `the first ${count} in file order were used`
  return `no expert_approved case in ${evalset}; ${selection}`
}

/** Freeze stage: one cite retrieval per case, written for the sweep to read. */
async function runFreezeStage(opts: SweepOptions): Promise<FrozenSet> {
  const file = frozenSetPath(opts.label)
  const path = evalsetPath(opts.evalset)
  const loaded = selectCases(opts)
  const evalset = basename(path)
  // Carried in the frozen set and printed here, because the sweep artifact's
  // header has no field for it.
  const evalsetNote = freezeNote(evalset, loaded, opts.ids)

  // A freeze at an existing label replaces that set, which is what --stage all
  // means: the retrieval is refetched, not reused. Said before the retrieval is
  // paid for — not after — so an operator who meant `--stage sweep` can stop
  // instead of buying a new set over the one they were replaying.
  if (existsSync(file)) {
    console.log(
      `overwriting the frozen set at ${file}: the retrieval is refetched, not reused`,
    )
  }

  console.log(
    `freezing ${loaded.cases.length} cases from ${evalset} at ${opts.target}`,
  )
  if (evalsetNote) console.log(`note: ${evalsetNote}`)

  const set = await freezeCases({
    cases: loaded.cases,
    target: opts.target,
    maxResults: MAX_RESULTS,
    label: opts.label,
    evalset,
    evalsetNote,
  })

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(set, null, 2))

  const empty = set.cases.filter((c) => c.doc_count === 0)
  console.log(
    `frozen: ${set.cases.length - empty.length}/${set.cases.length} cases returned documents`,
  )
  // Named now, not only in the readout: the sweep skips these, and knowing it
  // before the calls are paid for is the difference between a fix and a note.
  for (const c of empty)
    console.log(`  - ${c.id}: 0 documents, the sweep will skip it`)
  console.log(`frozen set: ${file}`)
  return set
}

function readFrozenSet(label: string): FrozenSet {
  const file = frozenSetPath(label)
  if (!existsSync(file)) {
    throw new Error(
      `no frozen set at ${file} — freeze one first with ` +
        `\`npm run eval:routes -- --stage freeze --label ${label} ...\`, ` +
        'or leave --stage at all to freeze and sweep in one run',
    )
  }
  return JSON.parse(readFileSync(file, 'utf8')) as FrozenSet
}

/**
 * Prints what the operator needs while the run is still warm: whether it
 * worked, and which calls did not. The readout stays the authority — it holds
 * every verdict and both outputs — but a sweep whose console says nothing sends
 * a person to parse markdown to find out whether the model answered at all.
 */
function printChecks(calls: CallResult[]): void {
  const failed = calls
    .map((call) => ({
      call,
      ...checkCall(call, call.model, inputCount(call.route, call.request)),
    }))
    .filter((v) => !v.ok)

  if (calls.length === 0) {
    console.log(
      '\nchecks: no calls recorded — every frozen case was skipped, so this run is evidence of nothing',
    )
    return
  }
  console.log(`\nchecks: ${failed.length} of ${calls.length} calls failed`)
  const shown = 20
  for (const f of failed.slice(0, shown)) {
    console.log(
      `  - ${f.call.route} / ${f.call.case_id} / ${f.call.model}: ${f.failures.join('; ')}`,
    )
  }
  if (failed.length > shown) {
    console.log(`  … and ${failed.length - shown} more in the readout`)
  }
}

/** Sweep stage: both models on every route over the frozen cases, then the two
 * output files. */
async function runSweepStage(
  opts: SweepOptions & { token: string },
  frozen: FrozenSet,
): Promise<void> {
  // One catalog fetch for the whole run: it only enriches the payloads (titles,
  // authors, the alignment summary's language list), and a failed lookup is
  // recorded as absent rather than ending a run.
  const catalogIndex = await fetchCatalogIndex(opts.target)
  if (!catalogIndex) {
    console.log(
      'catalog index unavailable: payloads are built without titles, authors and languages',
    )
  }

  // The digest belongs to QA's task. Another --target's responses came from a
  // build this tool cannot name, and recording QA's image there would be a
  // false statement about what answered.
  const codeVersion =
    opts.target === QA_TARGET
      ? await resolveCodeVersion(QA_ECS.service, QA_ECS.cluster, QA_ECS.region)
      : null
  console.log(`code version: ${codeVersion ?? 'unknown'}`)

  console.log(
    `sweeping ${frozen.cases.length} frozen cases × ${ROUTES.length} routes × ` +
      `${opts.models.length} models at ${opts.target} (concurrency ${opts.concurrency}, ` +
      `${opts.timeoutMs}ms per call)`,
  )
  const calls = await runSweep({
    cases: frozen.cases,
    routes: ROUTES,
    models: opts.models,
    catalogIndex,
    target: opts.target,
    token: opts.token,
    timeoutMs: opts.timeoutMs,
    concurrency: opts.concurrency,
  })

  const artifact: SweepArtifact = {
    label: opts.label,
    target: opts.target,
    models: opts.models,
    code_version: codeVersion,
    max_results: frozen.max_results,
    submodule_commit: frozen.submodule_commit,
    // The roster, so a case the sweep skipped is visible as skipped rather than
    // as a case nobody selected.
    cases: frozen.cases.map((c) => ({
      id: c.id,
      question: c.question,
      doc_count: c.doc_count,
    })),
    calls,
  }

  const files = artifactPath(opts.label)
  mkdirSync(dirname(files.json), { recursive: true })
  writeFileSync(files.json, JSON.stringify(artifact, null, 2))
  writeFileSync(files.md, renderMarkdown(artifact))

  printChecks(calls)
  console.log(`\nreadout:  ${files.md}`)
  console.log(`artifact: ${files.json}`)
}

async function main(argv: string[]): Promise<void> {
  const opts = parseSweepArgs(argv)
  const frozen =
    opts.stage === 'sweep'
      ? readFrozenSet(opts.label)
      : await runFreezeStage(opts)
  if (opts.stage === 'freeze') return

  if (!opts.token) throw new Error(TOKEN_REQUIRED)
  await runSweepStage({ ...opts, token: opts.token }, frozen)
}

// Guards the run so the module can be imported by its test without executing a
// sweep — the same guard the other evaluation entry points use.
if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  })
}
