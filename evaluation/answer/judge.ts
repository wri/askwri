/**
 * Judge stage (§3.2): resumable per-(case,pass,item) verdicts over a stored
 * capture. Item keys are `${caseId}|${pass}|${kind}:${index}`; the artifact is
 * rewritten (temp file + rename) after EVERY item so an abort — judge 401,
 * Ctrl-C — preserves progress, and `unjudged` tombstones from an aborted run
 * are retried on the next run.
 *
 * Resume safety: the judged artifact carries a fingerprint of the capture it
 * judged. A resume against a different capture (the same label re-captured)
 * is refused — verdict keys line up by (case, pass, item) and would otherwise
 * silently stand in for the new answers. Items judged by another model or
 * prompt version are re-judged, so one artifact never mixes judges.
 */
import { createHash } from 'node:crypto'
import * as fs from 'fs'
import { resolveProvider } from '../../src/lib/llm/chat-completions'
import {
  JudgeAuthError,
  JudgeOk,
  JudgeUnjudged,
  judgeCall,
} from './judge-client'
import {
  FACT_RECALL_SYSTEM,
  PROMPT_HASHES,
  SENTENCE_SUPPORT_SYSTEM,
  UNSUPPORTED_CLAIMS_SYSTEM,
  factRecallUser,
  sentenceSupportUser,
  unsupportedClaimsUser,
  validateFactRecall,
  validateSentenceSupport,
  validateUnsupportedClaims,
} from './judge-prompts'
import {
  CaptureArtifact,
  CaseCapture,
  JudgedArtifact,
  JudgedItem,
  JudgeUsageTotal,
  PassageSent,
} from './types'

export interface JudgeArgs {
  capture: CaptureArtifact
  /** Resume source and output — `judged-<label>.json`. */
  judgedPath: string
  judgeModel: string
  judgeBaseUrl: string
  /** case ids (capture-stage semantics); omit = all cases */
  only?: string[]
  concurrency?: number
}

export interface JudgeRunResult {
  artifact: JudgedArtifact
  /** Items judged OK in THIS run (resumed items are not counted). */
  judged: number
  /** Items tombstoned in this run. */
  unjudged: number
  /** Tombstone reasons → counts (e.g. {rate_limited: 2, http_400: 3}). */
  reasons: Record<string, number>
}

type Kind = 'fact_recall' | 'sentence_support' | 'unsupported_claims'

interface Job {
  key: string
  kind: Kind
  call: () => Promise<JudgeOk<any> | JudgeUnjudged>
  item: (r: JudgeOk<any>) => JudgedItem
}

/** Identity of a capture for resume safety: the cases, not the provenance
 * (a re-capture with identical answers is legitimately the same work). */
export const captureFingerprint = (capture: CaptureArtifact): string =>
  createHash('sha256').update(JSON.stringify(capture.cases)).digest('hex')

/** Atomic-ish write: temp file + rename, so a reader never sees a torn file. */
function writeJudgedArtifact(
  judgedPath: string,
  artifact: JudgedArtifact,
): void {
  const tmp = `${judgedPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(artifact, null, 2) + '\n')
  fs.renameSync(tmp, judgedPath)
}

/**
 * A failed item persists as a tombstone: only its presence + `unjudged`
 * matter (resume retries it), so the kind-specific verdict fields are
 * deliberately absent rather than stubbed.
 */
const tombstone = (job: Job, r: JudgeUnjudged): JudgedItem =>
  ({
    kind: job.kind,
    prompt_hash: r.prompt_hash,
    judge_model: r.judge_model,
    unjudged: r.unjudged,
  }) as unknown as JudgedItem

function enumerateJobs(
  cases: CaseCapture[],
  judgeModel: string,
  baseUrl: string,
  apiKey: string | undefined,
): Job[] {
  const jobs: Job[] = []
  const common = { judgeModel, baseUrl, apiKey }
  for (const c of cases) {
    const keyFacts = c.fixture_case.synthesis_ground_truth?.key_facts ?? []
    for (const p of c.passes) {
      // Answer-error passes are excluded from every mean the scorer computes
      // — spend no judge calls on them (their empty sentences would still
      // bill a fact_recall + unsupported_claims pair).
      if (p.answer.error) continue
      const a = p.answer
      const key = (kind: Kind, index?: number) =>
        `${c.case_id}|${p.pass}|${kind}:${index ?? ''}`

      if (keyFacts.length > 0) {
        jobs.push({
          key: key('fact_recall'),
          kind: 'fact_recall',
          call: () =>
            judgeCall({
              system: FACT_RECALL_SYSTEM,
              user: factRecallUser(keyFacts, a.sentences.join(' ')),
              validate: (json) => validateFactRecall(json, keyFacts.length),
              ...common,
            }),
          item: (r) => ({
            kind: 'fact_recall',
            verdicts: r.verdict,
            prompt_hash: r.prompt_hash,
            judge_model: r.judge_model,
          }),
        })
      }

      a.sentences.forEach((sentence, i) => {
        // Zero-cite sentences produce NO sentence_support item — they are
        // covered by unsupported_claims (ruling 4).
        const cited = (a.cites[i] ?? [])
          .map((id) => a.passages_sent.find((ps) => ps.id === id))
          .filter((ps): ps is PassageSent => ps !== undefined)
        if (cited.length === 0) return
        jobs.push({
          key: key('sentence_support', i),
          kind: 'sentence_support',
          call: () =>
            judgeCall({
              system: SENTENCE_SUPPORT_SYSTEM,
              user: sentenceSupportUser(
                sentence,
                cited.map((ps) => ({ text: ps.text })),
              ),
              validate: validateSentenceSupport,
              ...common,
            }),
          item: (r) => ({
            kind: 'sentence_support',
            sentence_index: i,
            verdict: r.verdict.verdict,
            span: r.verdict.span,
            prompt_hash: r.prompt_hash,
            judge_model: r.judge_model,
          }),
        })
      })

      jobs.push({
        key: key('unsupported_claims'),
        kind: 'unsupported_claims',
        call: () =>
          judgeCall({
            system: UNSUPPORTED_CLAIMS_SYSTEM,
            user: unsupportedClaimsUser(
              a.sentences,
              p.retrieval.chunks.map((ch) => ({ text: ch.text })),
            ),
            validate: (json) =>
              validateUnsupportedClaims(json, a.sentences.length),
            ...common,
          }),
        item: (r) => ({
          kind: 'unsupported_claims',
          unsupported_sentence_indices: r.verdict.unsupported_sentence_indices,
          reasons: r.verdict.reasons,
          prompt_hash: r.prompt_hash,
          judge_model: r.judge_model,
        }),
      })
    }
  }
  return jobs
}

export async function runJudge(args: JudgeArgs): Promise<JudgeRunResult> {
  const { capture, judgedPath, judgeModel, judgeBaseUrl } = args
  const only = args.only ?? []
  const concurrency = args.concurrency ?? 1
  // Key selection mirrors the app tier (resolveProvider): a URL matching
  // $LUNAROUTE_BASE_URL gets LUNAROUTE_API_KEY, anything else configured
  // gets OPENAI_API_KEY, and an unrecognized URL never receives a key.
  const apiKey = resolveProvider(judgeModel, {
    base_url: judgeBaseUrl || undefined,
  }).apiKey

  const unknown = only.filter(
    (id) => !capture.cases.some((c) => c.case_id === id),
  )
  if (unknown.length > 0) {
    throw new Error(`--only names unknown case id(s): ${unknown.join(', ')}`)
  }
  const cases =
    only.length > 0
      ? capture.cases.filter((c) => only.includes(c.case_id))
      : capture.cases

  // Resume: an existing artifact seeds the items map — but ONLY if it judged
  // this very capture. Its accumulated judge usage carries forward so a
  // resumed run's total spans both runs.
  const fingerprint = captureFingerprint(capture)
  const items: Record<string, JudgedItem> = {}
  let usageTotal: JudgeUsageTotal = {
    prompt_tokens: 0,
    completion_tokens: 0,
    calls: 0,
  }
  if (fs.existsSync(judgedPath)) {
    const existing = JSON.parse(
      fs.readFileSync(judgedPath, 'utf8'),
    ) as JudgedArtifact
    if (existing.capture_fingerprint !== fingerprint) {
      throw new Error(
        `refusing to resume ${judgedPath}: it judged a different capture ` +
          `(fingerprint ${existing.capture_fingerprint ?? 'absent'} vs ` +
          `${fingerprint}). Delete it, or judge under another --label.`,
      )
    }
    Object.assign(items, existing.items)
    if (existing.usage) usageTotal = { ...existing.usage }
  }

  const artifact: JudgedArtifact = {
    schema: 'answer-eval/judged@1',
    provenance: {
      ...capture.provenance,
      judge: {
        model: judgeModel,
        base_url: judgeBaseUrl,
        prompt_hashes: PROMPT_HASHES,
      },
    },
    capture_fingerprint: fingerprint,
    items,
  }

  const jobs = enumerateJobs(cases, judgeModel, judgeBaseUrl, apiKey)
  // Pending = missing, tombstoned, or judged by another model / prompt
  // version (re-judged so the artifact never mixes judges).
  const pending = jobs.filter((j) => {
    const it = items[j.key]
    return (
      !it ||
      it.unjudged ||
      it.judge_model !== judgeModel ||
      it.prompt_hash !== PROMPT_HASHES[j.kind]
    )
  })
  console.log(
    `[judge] ${pending.length} item(s) to judge, ` +
      `${jobs.length - pending.length} already judged`,
  )

  let authError: JudgeAuthError | undefined
  let judged = 0
  let unjudgedCount = 0
  const reasons: Record<string, number> = {}

  // Sequential when concurrency is 1 (the default); otherwise a simple
  // item-level worker pool.
  const queue = [...pending]
  const workerCount = Math.max(1, Math.min(concurrency, queue.length))
  await Promise.all(
    Array.from({ length: workerCount }, () =>
      (async () => {
        for (let j = queue.shift(); j && !authError; j = queue.shift()) {
          let r
          try {
            r = await j.call()
          } catch (e) {
            if (e instanceof JudgeAuthError) {
              authError = e
              return
            }
            throw e
          }
          if (r.ok) {
            judged++
            if (r.usage) {
              usageTotal.prompt_tokens += r.usage.prompt_tokens ?? 0
              usageTotal.completion_tokens += r.usage.completion_tokens ?? 0
              usageTotal.calls++
            }
          } else {
            unjudgedCount++
            reasons[r.unjudged.reason] = (reasons[r.unjudged.reason] ?? 0) + 1
          }
          items[j.key] = r.ok ? j.item(r) : tombstone(j, r)
          // Usage rides along on every write so a hard interrupt keeps it.
          artifact.usage = usageTotal
          writeJudgedArtifact(judgedPath, artifact)
          console.log(
            `${j.key} … ${r.ok ? 'ok' : `unjudged (${r.unjudged.reason})`}`,
          )
        }
      })(),
    ),
  )

  artifact.usage = usageTotal
  writeJudgedArtifact(judgedPath, artifact)

  if (authError) {
    // The write above guarantees the file exists even when the 401 hit the
    // first item; every completed item is already persisted.
    console.error(
      `[judge] ${authError.message} — partial artifact written to ${judgedPath}`,
    )
    throw authError
  }

  const reasonText = Object.entries(reasons)
    .map(([k, v]) => `${k}×${v}`)
    .join(', ')
  console.log(
    `[judge] ${judged} ok, ${unjudgedCount} unjudged` +
      (reasonText ? ` (${reasonText})` : ''),
  )
  if (usageTotal.calls > 0) {
    console.log(
      `[judge] usage: ${usageTotal.prompt_tokens} prompt + ${usageTotal.completion_tokens} completion tokens across ${usageTotal.calls} call(s)`,
    )
  }
  return { artifact, judged, unjudged: unjudgedCount, reasons }
}
