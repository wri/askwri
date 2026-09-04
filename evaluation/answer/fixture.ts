/**
 * Evalset loader + case accessor helpers. The evalsets live in the
 * evaluation/eval-review submodule (read-only); structural validation here
 * keeps harness runs from failing cryptically mid-capture on a malformed
 * fixture.
 */
import fs from 'fs'
import { Evalset, FixtureCase } from './types'

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
  es.test_cases.forEach((c, i) => validateCase(c, i))
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

function validateCase(c: FixtureCase, index: number): void {
  // Cases without an id can only be identified by position.
  const label =
    typeof c?.id === 'string' && c.id
      ? `case ${c.id}`
      : `case at index ${index}`
  if (!c?.id) fail(`${label}: missing id`)
  if (!c?.question) fail(`${label}: missing question`)
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

/** Expected doc ids (nested retrieval_ground_truth form). */
export function expectedIdsOf(c: FixtureCase): string[] {
  return c.retrieval_ground_truth?.expected_external_ids ?? []
}

/** True when the case is a negative case (no expected docs AND no key facts). */
export function isNegative(c: FixtureCase): boolean {
  return expectedIdsOf(c).length === 0 && keyFactsOf(c).length === 0
}
