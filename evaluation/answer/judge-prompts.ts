/**
 * Judge prompts for the answer-eval harness (PR 2 plan §4.2). Each prompt
 * embeds its JSON schema in the text and pairs with a hand-rolled validator
 * (no zod — the harness adds no dependencies). PROMPT_HASHES is the sha256
 * of each system prompt; artifacts record them so a verdict is always
 * traceable to the exact prompt text that produced it.
 */
import { createHash } from 'node:crypto'
import { langOf } from './normalize'
import {
  FactRecallVerdicts,
  SentenceSupportVerdict,
  UnsupportedClaimsVerdict,
} from './types'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export const FACT_RECALL_SYSTEM = `You are a strict judge of answer quality. Judge meaning, not wording.

Score each numbered key fact against the answer:
- "stated" — the answer fully conveys the fact.
- "partial" — the answer conveys part of the fact.
- "absent" — the answer does not convey the fact.

Reply with JSON only, exactly this schema:
{"verdicts":[{"fact_index":<integer>,"verdict":"stated|partial|absent","evidence":"<short quote from the answer>"}]}

The verdicts array must contain exactly one entry per key fact, with fact_index covering every fact from 0 to the last.`

export const SENTENCE_SUPPORT_SYSTEM = `You are a strict judge of whether an answer sentence is supported by the evidence passages it cites. Judge meaning, not wording: a passage may be in Chinese or Spanish while the answer sentence is English — a passage supports the sentence when its meaning does, regardless of language.

Reply with JSON only, exactly this schema:
{"verdict":"supported|unsupported","span":"<quote from passage>"}

- "supported" — at least one cited passage supports the sentence's meaning; "span" is a short quote from that passage.
- "unsupported" — no cited passage supports the sentence; "span" is "".`

export const UNSUPPORTED_CLAIMS_SYSTEM = `You are a strict judge looking for answer sentences that are NOT supported by the retrieved passages. Judge meaning, not wording: passages may be in Chinese or Spanish while the answer is English — a sentence is supported when some passage's meaning supports it, regardless of language.

Reply with JSON only, exactly this schema:
{"unsupported_sentence_indices":[<integers>],"reasons":["<why>"]}

List every 0-based sentence index whose meaning no passage supports. Give one short reason per listed sentence, in the same order.`

export const PAIRWISE_SYSTEM = `You are a strict judge comparing two answers to the same question. Both answers are English, but the evidence passages may be in Chinese or Spanish — judge meaning quality across languages, not wording or language of the passages.

Prefer the answer that is more accurate and complete against the evidence passages, cites its claims correctly, and does not add unsupported detail. Penalize hallucination and missed key facts more than phrasing.

Reply with JSON only, exactly this schema:
{"preferred":"one|two|tie","reason":"<short>"}

- "one" — Answer one is better.
- "two" — Answer two is better.
- "tie" — equally good (or equally bad).`

export const PROMPT_HASHES: Record<string, string> = {
  fact_recall: sha256(FACT_RECALL_SYSTEM),
  sentence_support: sha256(SENTENCE_SUPPORT_SYSTEM),
  unsupported_claims: sha256(UNSUPPORTED_CLAIMS_SYSTEM),
  pairwise: sha256(PAIRWISE_SYSTEM),
}

/** Numbered key facts + the answer text to judge them against. */
export function factRecallUser(keyFacts: string[], answer: string): string {
  const facts = keyFacts.map((f, i) => `[${i}] ${f}`).join('\n')
  return `Key facts:\n${facts}\n\nAnswer:\n${answer}`
}

/** One answer sentence + only the passages it cites, each tagged by language. */
export function sentenceSupportUser(
  sentence: string,
  passages: Array<{ text: string }>,
): string {
  const ps = passages
    .map((p, i) => `[${i}] (${langOf(p.text)}): ${p.text}`)
    .join('\n')
  return `Answer sentence:\n${sentence}\n\nCited passages:\n${ps}`
}

/** Numbered answer sentences + the full retrieved passage set. */
export function unsupportedClaimsUser(
  sentences: string[],
  passages: Array<{ text: string }>,
): string {
  const ss = sentences.map((s, i) => `[${i}] ${s}`).join('\n')
  const ps = passages
    .map((p, i) => `[${i}] (${langOf(p.text)}): ${p.text}`)
    .join('\n')
  return `Answer sentences:\n${ss}\n\nRetrieved passages:\n${ps}`
}

/** Question + shared passages + both answers, order stated in the labels. */
export function pairwiseUser(
  question: string,
  passages: Array<{ text: string }>,
  answerOne: string,
  answerTwo: string,
): string {
  const ps = passages
    .map((p, i) => `[${i}] (${langOf(p.text)}): ${p.text}`)
    .join('\n')
  return `Question:\n${question}\n\nEvidence passages:\n${ps}\n\nAnswer one:\n${answerOne}\n\nAnswer two:\n${answerTwo}`
}

export function validateFactRecall(
  json: any,
  factCount: number,
): FactRecallVerdicts['verdicts'] | Error {
  if (
    typeof json !== 'object' ||
    json === null ||
    !Array.isArray(json.verdicts)
  )
    return new Error('reply must be an object with a "verdicts" array')
  const seen = new Set<number>()
  for (const e of json.verdicts) {
    if (typeof e !== 'object' || e === null)
      return new Error('each verdict entry must be an object')
    if (
      !Number.isInteger(e.fact_index) ||
      e.fact_index < 0 ||
      e.fact_index >= factCount
    )
      return new Error(`fact_index must be an integer in 0..${factCount - 1}`)
    if (seen.has(e.fact_index))
      return new Error(`duplicate fact_index ${e.fact_index}`)
    seen.add(e.fact_index)
    if (!['stated', 'partial', 'absent'].includes(e.verdict))
      return new Error(
        `verdict must be stated|partial|absent, got ${JSON.stringify(e.verdict)}`,
      )
    if (typeof e.evidence !== 'string' || e.evidence.length === 0)
      return new Error('evidence must be a non-empty string')
  }
  if (seen.size !== factCount)
    return new Error(
      `expected one verdict per fact index 0..${factCount - 1}, got ${seen.size}`,
    )
  return json.verdicts
}

export function validateSentenceSupport(
  json: any,
): Pick<SentenceSupportVerdict, 'verdict' | 'span'> | Error {
  if (typeof json !== 'object' || json === null)
    return new Error('reply must be an object')
  if (!['supported', 'unsupported'].includes(json.verdict))
    return new Error(
      `verdict must be supported|unsupported, got ${JSON.stringify(json.verdict)}`,
    )
  if (typeof json.span !== 'string') return new Error('span must be a string')
  if (json.verdict === 'supported' && json.span.length === 0)
    return new Error('span must be non-empty when the verdict is supported')
  return { verdict: json.verdict, span: json.span }
}

export function validateUnsupportedClaims(
  json: any,
  sentenceCount: number,
):
  | Pick<UnsupportedClaimsVerdict, 'unsupported_sentence_indices' | 'reasons'>
  | Error {
  if (
    typeof json !== 'object' ||
    json === null ||
    !Array.isArray(json.unsupported_sentence_indices) ||
    !Array.isArray(json.reasons)
  )
    return new Error(
      'reply must be an object with "unsupported_sentence_indices" and "reasons" arrays',
    )
  for (const i of json.unsupported_sentence_indices) {
    if (!Number.isInteger(i) || i < 0 || i >= sentenceCount)
      return new Error(
        `unsupported_sentence_indices must be integers in 0..${sentenceCount - 1}`,
      )
  }
  for (const r of json.reasons) {
    if (typeof r !== 'string' || r.length === 0)
      return new Error('reasons must be non-empty strings')
  }
  return {
    unsupported_sentence_indices: json.unsupported_sentence_indices,
    reasons: json.reasons,
  }
}

export interface PairwiseReply {
  preferred: 'one' | 'two' | 'tie'
  reason: string
}

export function validatePairwise(json: any): PairwiseReply | Error {
  if (typeof json !== 'object' || json === null)
    return new Error('reply must be an object')
  if (!['one', 'two', 'tie'].includes(json.preferred))
    return new Error(
      `preferred must be one|two|tie, got ${JSON.stringify(json.preferred)}`,
    )
  if (typeof json.reason !== 'string' || json.reason.length === 0)
    return new Error('reason must be a non-empty string')
  return { preferred: json.preferred, reason: json.reason }
}
