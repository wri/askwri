/**
 * Judge stage (§3.2): resumable per-(case,pass,item) verdicts over a stored
 * capture. Item keys are `${caseId}|${pass}|${kind}:${index}`; the artifact is
 * rewritten (temp file + rename) after EVERY item so an abort — judge 401,
 * Ctrl-C — preserves progress, and `unjudged` tombstones from an aborted run
 * are retried on the next run.
 */
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

type Kind = 'fact_recall' | 'sentence_support' | 'unsupported_claims'

interface Job {
  key: string
  kind: Kind
  call: () => Promise<JudgeOk<any> | JudgeUnjudged>
  item: (r: JudgeOk<any>) => JudgedItem
}

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

export async function runJudge(args: JudgeArgs): Promise<JudgedArtifact> {
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

  // Resume: an existing artifact seeds the items map; keys that exist and
  // are not `unjudged` are skipped below.
  const items: Record<string, JudgedItem> = {}
  if (fs.existsSync(judgedPath)) {
    const existing = JSON.parse(
      fs.readFileSync(judgedPath, 'utf8'),
    ) as JudgedArtifact
    Object.assign(items, existing.items)
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
    items,
  }

  const jobs = enumerateJobs(cases, judgeModel, judgeBaseUrl, apiKey)
  const pending = jobs.filter((j) => !items[j.key] || items[j.key].unjudged)

  let promptTokens = 0
  let completionTokens = 0
  let usageCalls = 0
  let authError: JudgeAuthError | undefined

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
          if (r.ok && r.usage) {
            promptTokens += r.usage.prompt_tokens ?? 0
            completionTokens += r.usage.completion_tokens ?? 0
            usageCalls++
          }
          items[j.key] = r.ok ? j.item(r) : tombstone(j, r)
          writeJudgedArtifact(judgedPath, artifact)
          console.log(
            `${j.key} … ${r.ok ? 'ok' : `unjudged (${r.unjudged.reason})`}`,
          )
        }
      })(),
    ),
  )

  if (authError) {
    // Every completed item is already persisted; write once more so the
    // file exists even when the 401 hit the first item.
    writeJudgedArtifact(judgedPath, artifact)
    console.error(
      `[judge] ${authError.message} — partial artifact written to ${judgedPath}`,
    )
    throw authError
  }

  if (usageCalls > 0) {
    console.log(
      `[judge] usage: ${promptTokens} prompt + ${completionTokens} completion tokens across ${usageCalls} call(s)`,
    )
  }
  return artifact
}
