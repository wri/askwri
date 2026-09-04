/**
 * Pre-flight validation for the answer-eval harness (§3.4). Runs the cheap
 * checks that decide whether a capture is worth paying for, BEFORE any paid
 * synthesis or judge call:
 *
 * 1. Catalog check — every expected_external_ids id (and both members of
 *    each twin pair) must exist in the target's corpus.
 * 2. Snippet validation — per unique expected doc, one retrieval call with
 *    cite_doc_ids (forwardable QueryRequest field), the reranker OFF, and
 *    every pool widened (SNIPPET_LOOKUP_KNOBS); every expected_passages
 *    text_snippet must be snippetContained in some returned chunk. Only
 *    retrieval is spent here (its usage is summed and printed).
 *
 *    Why rerank:false — the reranker's top_n (20 in the answer preset) and
 *    the search-service's answer_rerank_per_doc_cap both truncate the doc's
 *    chunk list, and they are exactly the settings the spec's sweeps flip;
 *    with the cap active a doc could never return more than a handful of
 *    chunks and every run would abort. Fusion depth still bounds the pool
 *    (fusion_top_k is applied before max_results), hence the wide top-ks.
 *    Known limit: the search-service's translation-pair filter runs BEFORE
 *    rerank in answer mode (main.py, load_confirmed_pairs), so with
 *    translation_pairs_enabled=true a translation-side expected doc returns
 *    zero chunks — preflight the translation-pair sweep with the flag OFF.
 * 3. Provider probes — one minimal synthesis call carrying the run's
 *    provider knobs (model / base_url / prompt_version), then (only when
 *    judging in the same run) one judge ping. The route hides provider
 *    failures behind HTTP 200 + debug.fallbackReason, so a fallback reply
 *    FAILS the probe. (It is one real synthesis call, not one token — the
 *    route exposes no token cap.)
 *
 * Failure of (1)/(2) is recorded in the report and aborts before the probes
 * (their ok flags come back false). The report is the capture artifact's
 * preflight field — the pure scorer's only source of corpus attainability —
 * so failures are returned, not thrown.
 */
import { fetchJson } from './http'
import { expectedIdsOf, twinOf } from './fixture'
import { snippetContained } from './normalize'
import { TargetClient } from './target'
import { Evalset, FixtureCase, PreflightReport } from './types'

/** The synthesis probe's fake doc — a minimal /api/answer payload shape. */
const PROBE_DOC = {
  doc_id: 'preflight-probe',
  title: 'Preflight probe',
  kps: [
    {
      snippet: 'A minimal probe passage.',
      passage_id: 'preflight-probe',
      page: 1,
    },
  ],
}

/** Snippet-lookup retrieval knobs (all FORWARDABLE_FIELDS). See the header. */
const SNIPPET_LOOKUP_KNOBS = {
  rerank: false,
  vector_top_k: 300,
  bm25_top_k: 300,
  fusion_top_k: 300,
  max_results: 300,
} as const

/** The synthesis knobs that select a provider/prompt — forwarded to the
 * probe so it exercises what the run will use. Size knobs are NOT
 * forwarded: the probe keeps its own minimal caps. */
const PROBE_FORWARDED_KNOBS = ['model', 'base_url', 'prompt_version'] as const

/** Sentence-count stand-in for the judge estimate: the fixture's canonical
 * answer when present (the synthesis targets the same content), else the
 * route prompt's 2-3 sentence target. The real count is unknowable
 * pre-run; this only sizes the estimate. */
function estimateSentences(c: FixtureCase): number {
  const canonical = c.synthesis_ground_truth?.canonical_answer
  if (!canonical) return 3
  return Math.max(1, (canonical.match(/[.!?]+(\s|$)/g) ?? []).length)
}

/** One judge-ping via raw fetchJson (the judge client arrives in a later
 * task — do not import it from here). Non-200 → false, with a 401 message
 * distinguishing auth failure from other errors. */
async function judgeProbe(cfg: {
  model: string
  baseUrl: string
  apiKey?: string
}): Promise<boolean> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
  let status: number | null = null
  try {
    const r = await fetchJson(url, {
      method: 'POST',
      headers: cfg.apiKey
        ? { Authorization: `Bearer ${cfg.apiKey}` }
        : undefined,
      body: {
        model: cfg.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      },
    })
    status = r.status
  } catch (e) {
    console.error(
      `preflight: judge probe unreachable at ${cfg.baseUrl}: ${(e as Error).message}`,
    )
    return false
  }
  if (status === 200) return true
  if (status === 401) {
    console.error(
      `preflight: judge probe unauthorized (401) at ${cfg.baseUrl} — check the judge API key`,
    )
  } else {
    console.error(`preflight: judge probe failed (${status}) at ${cfg.baseUrl}`)
  }
  return false
}

export async function preflight(args: {
  evalset: Evalset
  target: TargetClient
  judgeCfg?: { model: string; baseUrl: string; apiKey?: string }
  passes: number
  only?: string[]
  /** The run's --knob synthesis values; provider-selecting ones reach the probe. */
  synthesisKnobs?: Record<string, unknown>
}): Promise<PreflightReport> {
  const { evalset, target, judgeCfg, passes } = args
  const cases = args.only
    ? evalset.test_cases.filter((c) => args.only!.includes(c.id))
    : evalset.test_cases

  // (1) Catalog check: expected ids plus both members of each twin pair.
  const catalog = await target.catalogIds()
  const missing = new Set<string>()
  let corpus_ok = true
  let twins_ok = true
  for (const c of cases) {
    for (const id of expectedIdsOf(c)) {
      if (!catalog.has(id)) {
        corpus_ok = false
        missing.add(id)
      }
      const twin = twinOf(evalset, id)
      if (twin) {
        if (!catalog.has(id) || !catalog.has(twin)) twins_ok = false
        if (!catalog.has(twin)) missing.add(twin)
      }
    }
  }
  const missing_docs = [...missing].sort()

  // (2) Snippet validation — retrieval only. One call per unique expected doc
  // per case; cite_doc_ids restricts the search to that doc's chunks and
  // SNIPPET_LOOKUP_KNOBS keeps the reranker (and its caps) out of the way.
  const snippet_failures: PreflightReport['snippet_failures'] = []
  let lookupUsd = 0
  let lookupCalls = 0
  for (const c of cases) {
    const byDoc = new Map<string, Array<{ text_snippet: string }>>()
    for (const p of c.retrieval_ground_truth?.expected_passages ?? []) {
      const list = byDoc.get(p.doc_id) ?? []
      list.push(p)
      byDoc.set(p.doc_id, list)
    }
    for (const [docId, passages] of byDoc) {
      let outcome
      try {
        outcome = await target.retrieve(c.question, {
          cite_doc_ids: [docId],
          ...SNIPPET_LOOKUP_KNOBS,
        })
        if (outcome.cost_usd != null) {
          lookupUsd += outcome.cost_usd
          lookupCalls++
        }
      } catch (e) {
        snippet_failures.push({
          case_id: c.id,
          doc_id: docId,
          reason: `retrieval failed: ${(e as Error).message}`,
        })
        continue
      }
      if (outcome.chunks.length === 0) {
        snippet_failures.push({
          case_id: c.id,
          doc_id: docId,
          reason: 'no chunks returned for doc',
        })
        continue
      }
      passages.forEach((p, i) => {
        if (
          !outcome.chunks.some((ch) =>
            snippetContained(p.text_snippet, ch.text),
          )
        ) {
          snippet_failures.push({
            case_id: c.id,
            doc_id: docId,
            reason: `snippet ${i + 1} not contained in any returned chunk`,
          })
        }
      })
    }
  }

  // (3) Provider probes — only after (1)/(2) pass; a corpus or snippet
  // failure aborts before any paid call.
  let synthesis_probe_ok = false
  // No judging in this run → vacuously ok (nothing to validate).
  let judge_probe_ok = !judgeCfg
  if (corpus_ok && twins_ok && snippet_failures.length === 0) {
    const forwarded: Record<string, unknown> = {}
    for (const k of PROBE_FORWARDED_KNOBS) {
      const v = args.synthesisKnobs?.[k]
      if (v !== undefined) forwarded[k] = v
    }
    const probe = await target.answer('ping', [PROBE_DOC], {
      ...forwarded,
      max_passages: 1,
      passage_chars: 50,
    })
    const fallback: string | undefined = probe.debug?.fallbackReason
    synthesis_probe_ok = probe.ok && !probe.error && !fallback
    if (fallback) {
      console.error(
        `preflight: synthesis probe fell back (${fallback}) — the route hid a ` +
          `provider failure; check the synthesis API key / base_url`,
      )
    }
    if (synthesis_probe_ok && judgeCfg) {
      judge_probe_ok = await judgeProbe(judgeCfg)
    }
  }

  // (4) Counts + call estimate.
  const approved = cases.filter(
    (c) => c.review_status === 'expert_approved',
  ).length
  const rejected = cases.filter((c) => c.review_status === 'rejected').length
  const draft = cases.length - approved - rejected
  // Each case×pass spends one retrieval and one synthesis call. Judge items:
  // per case×pass, 1 fact-recall + 1 per (estimated) sentence + 1 unsupported.
  const estimated_calls = {
    retrieval: cases.length * passes,
    synthesis: cases.length * passes,
    judge: judgeCfg
      ? cases.reduce((sum, c) => sum + passes * (2 + estimateSentences(c)), 0)
      : 0,
  }

  const report: PreflightReport = {
    corpus_ok,
    missing_docs,
    snippet_failures,
    twins_ok,
    synthesis_probe_ok,
    judge_probe_ok,
    approved,
    draft,
    rejected,
    estimated_calls,
  }

  console.log(
    `[preflight] corpus_ok=${corpus_ok} twins_ok=${twins_ok} ` +
      `synthesis_probe_ok=${synthesis_probe_ok} judge_probe_ok=${judge_probe_ok}`,
  )
  if (missing_docs.length > 0) {
    console.log(`[preflight] missing docs: ${missing_docs.join(', ')}`)
  }
  if (lookupCalls > 0) {
    console.log(
      `[preflight] snippet-lookup retrieval spend $${lookupUsd.toFixed(4)} ` +
        `across ${lookupCalls} call(s) (not part of the capture cost total)`,
    )
  }
  for (const f of snippet_failures) {
    console.log(
      `[preflight] snippet failure: ${f.case_id} / ${f.doc_id}: ${f.reason}`,
    )
  }
  console.log(
    `[preflight] cases=${cases.length} (approved=${approved} draft=${draft} ` +
      `rejected=${rejected}) estimated calls: ` +
      `retrieval=${estimated_calls.retrieval} synthesis=${estimated_calls.synthesis} ` +
      `judge=${estimated_calls.judge}`,
  )
  return report
}
