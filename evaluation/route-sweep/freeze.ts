/**
 * Freeze stage: one cite retrieval per case, at the target gateway, saved so
 * every downstream stage reads the same documents. `max_results` is the
 * caller's — the CLI passes 40, mirroring what the UI sends — and is recorded
 * rather than assumed, because it is the input size for three of the four
 * route payloads and it selects their truncation regime.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { FrozenCase, FrozenSet } from './types'

// The evalsets live in this submodule. Its checked-out commit is part of the
// frozen set's provenance, so it is read, never bumped: the pin is the anchor
// that makes a frozen set traceable back to the ground truth it came from.
const SUBMODULE_DIR = 'evaluation/eval-review'

export type EvalsetCase = {
  id: string
  question: string
  source_language?: string
}

export type LoadedEvalset = {
  cases: EvalsetCase[]
  /** True only when the file had `review_status: 'expert_approved'` cases and
   * the selection was filtered down to them. */
  expert_approved_only: boolean
}

/**
 * Selects cases from a pinned evalset. The reviewed tier is preferred when a
 * future pin introduces it; at pin 1dcbeab no case carries `review_status`, so
 * the default is "first `limit` cases in file order" and the caller records
 * that the set had no reviewed tier.
 */
export function loadEvalset(
  evalsetPath: string,
  opts: { limit?: number; ids?: string[] },
): LoadedEvalset {
  if (!existsSync(evalsetPath)) {
    throw new Error(
      `evalset not found: ${evalsetPath} — the evalsets live in the ` +
        `${SUBMODULE_DIR} submodule; run ` +
        `\`git submodule update --init ${SUBMODULE_DIR}\``,
    )
  }

  const parsed = JSON.parse(readFileSync(evalsetPath, 'utf8')) as {
    test_cases?: (EvalsetCase & { review_status?: string })[]
  }
  const all = Array.isArray(parsed.test_cases) ? parsed.test_cases : []
  const approved = all.filter((c) => c.review_status === 'expert_approved')

  let selected = approved.length > 0 ? approved : all
  if (opts.ids) {
    const missing = opts.ids.filter((id) => !selected.some((c) => c.id === id))
    if (missing.length > 0) {
      throw new Error(
        `unknown case id(s) in ${evalsetPath}: ${missing.join(', ')}`,
      )
    }
    const wanted = new Set(opts.ids)
    selected = selected.filter((c) => wanted.has(c.id))
  }
  if (opts.limit !== undefined) selected = selected.slice(0, opts.limit)

  return {
    cases: selected.map((c) => ({
      id: c.id,
      question: c.question,
      source_language: c.source_language,
    })),
    expert_approved_only: approved.length > 0,
  }
}

/** The submodule's checked-out commit, read from git rather than the parent
 * tree's index: an uncommitted bump must show up in the artifact. */
function submoduleCommit(): string {
  return execFileSync('git', ['-C', SUBMODULE_DIR, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
}

/**
 * Runs one cite query per case and records the documents it returned. A case
 * that returns zero documents is data, not an error — `doc_count` carries it
 * and a later stage decides what such a case is worth. A failed retrieval is
 * an error: recording it as zero documents would be indistinguishable from a
 * case the corpus genuinely cannot answer.
 */
export async function freezeCases(args: {
  cases: EvalsetCase[]
  target: string
  maxResults: number
  label: string
  evalset: string
  evalsetNote?: string
  fetchImpl?: typeof fetch
}): Promise<FrozenSet> {
  const doFetch = args.fetchImpl ?? fetch
  const base = args.target.replace(/\/+$/, '')
  const commit = submoduleCommit()

  const cases: FrozenCase[] = []
  for (const c of args.cases) {
    const response = await doFetch(`${base}/api/llamaindex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: c.question,
        mode: 'cite',
        max_results: args.maxResults,
      }),
    })
    if (!response.ok) {
      throw new Error(
        `cite retrieval failed for ${c.id}: ${response.status} - ` +
          `${await response.text()}`,
      )
    }
    const data = (await response.json()) as { docs?: unknown[] }
    const docs = Array.isArray(data.docs) ? data.docs : []
    cases.push({ ...c, docs, doc_count: docs.length })
  }

  return {
    label: args.label,
    target: args.target,
    evalset: args.evalset,
    submodule_commit: commit,
    max_results: args.maxResults,
    cases,
    ...(args.evalsetNote ? { evalsetNote: args.evalsetNote } : {}),
  }
}
