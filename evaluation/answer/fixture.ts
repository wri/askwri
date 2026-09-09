/**
 * Evalset loader + case accessor helpers. The evalsets live in the
 * evaluation/eval-review submodule (read-only); structural validation here
 * keeps harness runs from failing cryptically mid-capture on a malformed
 * fixture.
 */
import fs from 'fs'
import { DocSet, Evalset, FixtureCase } from './types'

export function loadEvalset(path: string): Evalset {
  const evalset = JSON.parse(fs.readFileSync(path, 'utf-8')) as Evalset
  validate(evalset)
  return evalset
}

function fail(msg: string): never {
  throw new Error(`evalset invalid: ${msg}`)
}

function validate(es: Evalset): void {
  if (!Array.isArray(es.test_cases)) {
    fail('test_cases must be an array')
  }
  const setIds = validateDocSets(es)
  es.test_cases.forEach((c, i) => validateCase(c, i, setIds))
  es.twins?.forEach((t, i) => {
    if (
      !Array.isArray(t) ||
      t.length !== 2 ||
      t.some((m) => typeof m !== 'string')
    ) {
      fail(`twins[${i}] must be a [string, string] pair`)
    }
  })
}

/** Structural validation of doc_sets; returns the set of valid ids for
 * case-reference resolution. Absent doc_sets is tolerated (no-selection
 * mode never reads them; the fixture-set capture errors per-case instead). */
function validateDocSets(es: Evalset): Set<string> {
  if (es.doc_sets === undefined) return new Set()
  if (!Array.isArray(es.doc_sets)) {
    fail('doc_sets must be an array')
  }
  const ids = new Set<string>()
  es.doc_sets.forEach((s, i) => {
    if (!s || typeof s.id !== 'string' || !s.id) {
      fail(`doc_sets[${i}]: missing id`)
    }
    if (ids.has(s.id)) {
      fail(`doc_sets[${i}]: duplicate id ${s.id}`)
    }
    ids.add(s.id)
    if (
      !Array.isArray(s.doc_ids) ||
      s.doc_ids.length === 0 ||
      s.doc_ids.some((d) => typeof d !== 'string' || !d)
    ) {
      fail(`doc_sets[${s.id}]: doc_ids must be a non-empty array of strings`)
    }
  })
  return ids
}

function validateCase(
  c: FixtureCase,
  index: number,
  setIds: Set<string>,
): void {
  // Cases without an id can only be identified by position.
  const label =
    typeof c?.id === 'string' && c.id
      ? `case ${c.id}`
      : `case at index ${index}`
  if (!c?.id) fail(`${label}: missing id`)
  if (!c?.question) fail(`${label}: missing question`)
  if (c.doc_set_id !== undefined) {
    if (typeof c.doc_set_id !== 'string' || !c.doc_set_id) {
      fail(`${label}: doc_set_id must be a non-empty string`)
    }
    if (!setIds.has(c.doc_set_id)) {
      fail(`${label}: doc_set_id "${c.doc_set_id}" names no doc set`)
    }
  }
  const passages = c?.retrieval_ground_truth?.expected_passages
  if (passages) {
    if (!Array.isArray(passages)) {
      fail(`${label}: expected_passages must be an array`)
    }
    passages.forEach((p, j) => {
      if (!p?.doc_id || !p?.text_snippet) {
        fail(`${label}: expected_passages[${j}] missing doc_id/text_snippet`)
      }
    })
  }
}

/** Twin partner of a doc id, or undefined. */
export function twinOf(evalset: Evalset, docId: string): string | undefined {
  const pair = evalset.twins?.find(([a, b]) => a === docId || b === docId)
  if (!pair) return undefined
  return pair[0] === docId ? pair[1] : pair[0]
}

/** Key facts of a case ([] when absent). */
export function keyFactsOf(c: FixtureCase): string[] {
  return c.synthesis_ground_truth?.key_facts ?? []
}

/** The doc set a case is answered within, or undefined when the case has
 * no curated set (no-selection tolerance; fixture-set capture hard-errors
 * on that instead — load only guarantees that a PRESENT doc_set_id
 * resolves). find-first is safe: duplicate set ids are rejected at load
 * (validateDocSets), so at most one set can match. */
export function docSetOf(evalset: Evalset, c: FixtureCase): DocSet | undefined {
  if (!c.doc_set_id) return undefined
  return evalset.doc_sets?.find((s) => s.id === c.doc_set_id)
}

/** Expected docs (and their twins, when they exist) that are not in the
 * case's doc set — the capture-time subset check (q16's union must hold).
 * [] when the case has no doc set or no expected docs (negatives). */
export function expectedDocsOutsideSet(
  evalset: Evalset,
  c: FixtureCase,
): string[] {
  const set = docSetOf(evalset, c)
  if (!set) return []
  const inSet = new Set(set.doc_ids)
  const out: string[] = []
  for (const id of expectedIdsOf(c)) {
    if (!inSet.has(id)) out.push(id)
    const twin = twinOf(evalset, id)
    if (twin && !inSet.has(twin)) out.push(twin)
  }
  return [...new Set(out)]
}

/** Expected doc ids (nested retrieval_ground_truth form). */
export function expectedIdsOf(c: FixtureCase): string[] {
  return c.retrieval_ground_truth?.expected_external_ids ?? []
}

/** True when the case is a negative case (no expected docs AND no key facts). */
export function isNegative(c: FixtureCase): boolean {
  return expectedIdsOf(c).length === 0 && keyFactsOf(c).length === 0
}
