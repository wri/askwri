/**
 * Freeze stage: one cite retrieval per case, at the target gateway, saved so
 * every downstream stage reads the same documents. `max_results` is the
 * caller's — the CLI passes 40, mirroring what the UI sends — and is recorded
 * rather than assumed, because it is the input size for three of the four
 * route payloads and it selects their truncation regime.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { FrozenCase, FrozenSet } from './types'

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
 * Selects cases from a versioned evalset. The reviewed tier is preferred when
 * one exists; otherwise the default is "first `limit` cases in file order" and
 * the caller records that the set had no reviewed tier.
 */
export function loadEvalset(
  evalsetPath: string,
  opts: { limit?: number; ids?: string[] },
): LoadedEvalset {
  if (!existsSync(evalsetPath)) {
    throw new Error(`evalset not found: ${evalsetPath}`)
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

/** Content digest of the exact fixture used for this frozen set. */
function fixtureSha256(evalsetPath: string): string {
  return createHash('sha256').update(readFileSync(evalsetPath)).digest('hex')
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
  evalsetPath: string
  evalsetNote?: string
  fetchImpl?: typeof fetch
}): Promise<FrozenSet> {
  const doFetch = args.fetchImpl ?? fetch
  const base = args.target.replace(/\/+$/, '')
  const fixtureDigest = fixtureSha256(args.evalsetPath)

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
    fixture_sha256: fixtureDigest,
    max_results: args.maxResults,
    cases,
    ...(args.evalsetNote ? { evalsetNote: args.evalsetNote } : {}),
  }
}
