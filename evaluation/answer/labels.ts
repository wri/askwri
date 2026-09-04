/**
 * Human labels (§4.5): the loader for the eval-review notebook's
 * `answer-eval/human-labels@1` artifacts and the judge-vs-human agreement
 * view over a judged artifact.
 *
 * Agreement tallies mirror compare.ts's `judgedAgreement`: for verdict type
 * v the denominator is the positions where BOTH judge and human produced a
 * verdict and at least one said v — a disagreement therefore shows up in
 * both buckets. Labeled items whose judged counterpart is missing or
 * unjudged are never treated as a verdict; they count in their tally's
 * `excluded`.
 *
 * Zero-cite sentences (judge.ts ruling 4) produce NO judged
 * `sentence_support` item — the judge covers them only through
 * `unsupported_claims`, and so do these tallies: the sentence_support
 * tally joins only over judged `sentence_support:<i>` items (the capture
 * distinguishes a legitimately absent item from an unjudged one), while
 * `unsupported_claims` joins EVERY human sentence verdict against membership
 * in the judged item's `unsupported_sentence_indices`.
 */
import * as fs from 'fs'
import * as path from 'path'
import { captureFingerprint } from './judge'
import {
  CaptureArtifact,
  HumanFactVerdict,
  HumanLabels,
  HumanSentenceVerdict,
  JudgeAgreement,
  JudgedArtifact,
  JudgedItem,
  VerdictTally,
} from './types'

export type {
  HumanFactVerdict,
  HumanLabels,
  HumanSentenceVerdict,
  JudgeAgreement,
  VerdictTally,
} from './types'

const SCHEMA = 'answer-eval/human-labels@1'
const FACT_VERDICTS = ['stated', 'partial', 'absent']
const SENTENCE_VERDICTS = ['supported', 'unsupported']

function fail(origin: string, msg: string): never {
  throw new Error(`labels invalid (${origin}): ${msg}`)
}

/** Throws on any schema violation, with the file path in the message. */
export function parseLabels(text: string, origin: string): HumanLabels {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(
      `labels invalid (${origin}): not valid JSON — ${(e as Error).message}`,
    )
  }
  if (raw?.schema !== SCHEMA) {
    fail(origin, `schema must be "${SCHEMA}"`)
  }
  if (typeof raw.capture_file !== 'string' || raw.capture_file === '') {
    fail(origin, 'capture_file must be a non-empty string')
  }
  if (typeof raw.capture_fingerprint !== 'string') {
    fail(origin, 'capture_fingerprint must be a string')
  }
  if (!/^[0-9a-f]{64}$/i.test(raw.capture_fingerprint)) {
    fail(origin, 'capture_fingerprint must be 64 hex chars')
  }
  if (typeof raw.case_id !== 'string' || raw.case_id === '') {
    fail(origin, 'case_id must be a non-empty string')
  }
  if (!Number.isInteger(raw.pass) || raw.pass < 0) {
    fail(origin, 'pass must be an integer >= 0')
  }
  if (typeof raw.reviewer !== 'string' || raw.reviewer === '') {
    fail(origin, 'reviewer must be a non-empty string')
  }
  if (!Array.isArray(raw.fact_verdicts)) {
    fail(origin, 'fact_verdicts must be an array')
  }
  raw.fact_verdicts.forEach((v: HumanFactVerdict, i: number) => {
    if (!Number.isInteger(v?.fact_index) || v.fact_index < 0) {
      fail(origin, `fact_verdicts[${i}].fact_index must be an integer >= 0`)
    }
    if (!FACT_VERDICTS.includes(v?.verdict)) {
      fail(
        origin,
        `fact_verdicts[${i}].verdict must be one of ${FACT_VERDICTS.join(', ')}`,
      )
    }
  })
  if (!Array.isArray(raw.sentence_verdicts)) {
    fail(origin, 'sentence_verdicts must be an array')
  }
  raw.sentence_verdicts.forEach((v: HumanSentenceVerdict, i: number) => {
    if (!Number.isInteger(v?.sentence_index) || v.sentence_index < 0) {
      fail(
        origin,
        `sentence_verdicts[${i}].sentence_index must be an integer >= 0`,
      )
    }
    if (!SENTENCE_VERDICTS.includes(v?.verdict)) {
      fail(
        origin,
        `sentence_verdicts[${i}].verdict must be one of ${SENTENCE_VERDICTS.join(', ')}`,
      )
    }
  })
  return raw as HumanLabels
}

/** Files and/or directories (dirs glob *.json, sorted for determinism). */
export function loadLabelsFrom(paths: string[]): HumanLabels[] {
  const out: HumanLabels[] = []
  for (const p of paths) {
    if (fs.statSync(p).isDirectory()) {
      const files = fs
        .readdirSync(p)
        .filter((f) => f.endsWith('.json'))
        .sort()
      for (const f of files) {
        const full = path.join(p, f)
        out.push(parseLabels(fs.readFileSync(full, 'utf8'), full))
      }
    } else {
      out.push(parseLabels(fs.readFileSync(p, 'utf8'), p))
    }
  }
  return out
}

/** Fingerprint + case + pass existence against THIS capture. */
export function validateLabelsAgainstCapture(
  labels: HumanLabels,
  capture: CaptureArtifact,
): { ok: true } | { ok: false; reason: string } {
  const fingerprint = captureFingerprint(capture)
  if (labels.capture_fingerprint !== fingerprint) {
    return {
      ok: false,
      reason:
        `capture_fingerprint mismatch (labels ${labels.capture_fingerprint} ` +
        `vs capture ${fingerprint})`,
    }
  }
  const c = capture.cases.find((x) => x.case_id === labels.case_id)
  if (!c) {
    return { ok: false, reason: `unknown case_id ${labels.case_id}` }
  }
  if (!c.passes.some((p) => p.pass === labels.pass)) {
    return {
      ok: false,
      reason: `case ${labels.case_id} has no pass ${labels.pass}`,
    }
  }
  return { ok: true }
}

const newTally = (): VerdictTally => ({ agree: {}, either: {}, excluded: 0 })

/** Judged item for `${caseId}|${pass}|${suffix}`, or undefined. Keys follow
 * judge.ts's builder exactly (`${kind}:${index ?? ''}` — indexless kinds
 * carry a trailing colon). */
const judgedItem = (
  judged: JudgedArtifact,
  caseId: string,
  pass: number,
  suffix: string,
): JudgedItem | undefined => judged.items[`${caseId}|${pass}|${suffix}`]

/** True when answer sentence i has at least one resolvable citation in the
 * capture — the same zero-cite rule that decides whether judge.ts emits a
 * `sentence_support` item for it. */
function sentenceIsCited(
  capture: CaptureArtifact,
  caseId: string,
  pass: number,
  sentenceIndex: number,
): boolean {
  const c = capture.cases.find((x) => x.case_id === caseId)
  const p = c?.passes.find((x) => x.pass === pass)
  if (!p) return false
  const a = p.answer
  return (a.cites[sentenceIndex] ?? []).some((id) =>
    a.passages_sent.some((ps) => ps.id === id),
  )
}

/** One judge-vs-human comparison with judgedAgreement's symmetric measure.
 * Unlike judgedAgreement (one shared bucket per language), tallies here are
 * per verdict TYPE, so a disagreement fills `either` in BOTH sides' type
 * tallies: the human verdict's tally and the judge verdict's tally — each
 * bucket's denominator stays "positions where at least one side said v". */
function compare(
  tallies: Record<string, VerdictTally>,
  human: string,
  judge: string,
): void {
  const t = tallies[human]
  if (human === judge) {
    t.agree[human] = (t.agree[human] ?? 0) + 1
    t.either[human] = (t.either[human] ?? 0) + 1
  } else {
    t.either[human] = (t.either[human] ?? 0) + 1
    const tj = tallies[judge]
    tj.either[judge] = (tj.either[judge] ?? 0) + 1
  }
}

/**
 * Judge-vs-human per-verdict-type agreement over one judged artifact.
 * Labels are deduped by (case_id, pass, reviewer) — the last occurrence
 * wins (a reviewer's corrected file supersedes their earlier one); labels
 * from DIFFERENT reviewers for the same (case, pass) all join, each human
 * verdict compared independently against the same judged items.
 */
export function judgeHumanAgreement(
  judged: JudgedArtifact,
  labels: HumanLabels[],
  capture: CaptureArtifact,
): JudgeAgreement {
  const byKey = new Map<string, HumanLabels>()
  for (const l of labels) {
    byKey.set(`${l.case_id}|${l.pass}|${l.reviewer}`, l)
  }
  const deduped = [...byKey.values()]

  const factTally = {
    stated: newTally(),
    partial: newTally(),
    absent: newTally(),
  }
  const sentTally = {
    supported: newTally(),
    unsupported: newTally(),
  }
  let ucAgree = 0
  let ucCompared = 0

  for (const l of deduped) {
    // unsupported_claims joins over ALL labeled sentences — but only against
    // a judged item that exists and is not a tombstone.
    const uc = judgedItem(judged, l.case_id, l.pass, 'unsupported_claims:')
    const ucIndices =
      uc && !uc.unjudged && uc.kind === 'unsupported_claims'
        ? new Set(uc.unsupported_sentence_indices)
        : undefined

    for (const fv of l.fact_verdicts) {
      const t = factTally[fv.verdict]
      const j = judgedItem(judged, l.case_id, l.pass, 'fact_recall:')
      const jv =
        j && !j.unjudged && j.kind === 'fact_recall'
          ? j.verdicts.find((v) => v.fact_index === fv.fact_index)?.verdict
          : undefined
      if (jv === undefined) {
        t.excluded++
        continue
      }
      compare(factTally, fv.verdict, jv)
    }

    for (const sv of l.sentence_verdicts) {
      // Zero-cite sentences legitimately have no judged sentence_support
      // item (judge.ts ruling 4) — they join only through unsupported_claims
      // below, never as an exclusion.
      if (sentenceIsCited(capture, l.case_id, l.pass, sv.sentence_index)) {
        const t = sentTally[sv.verdict]
        const j = judgedItem(
          judged,
          l.case_id,
          l.pass,
          `sentence_support:${sv.sentence_index}`,
        )
        const jv =
          j && !j.unjudged && j.kind === 'sentence_support'
            ? j.verdict
            : undefined
        if (jv === undefined) {
          t.excluded++
        } else {
          compare(sentTally, sv.verdict, jv)
        }
      }
      if (ucIndices !== undefined) {
        ucCompared++
        if (
          (sv.verdict === 'unsupported') ===
          ucIndices.has(sv.sentence_index)
        ) {
          ucAgree++
        }
      }
    }
  }

  return {
    fact_recall: factTally,
    sentence_support: sentTally,
    unsupported_claims: { agree: ucAgree, compared: ucCompared },
    labels: deduped.length,
    reviewers: [...new Set(deduped.map((l) => l.reviewer))].sort(),
  }
}
