/**
 * Pre-flight validation for the answer-eval harness (§3.4). Runs the cheap
 * checks that decide whether a capture is worth paying for, BEFORE any paid
 * synthesis or judge call:
 *
 * 1. Catalog check — every expected_external_ids id (and both members of
 *    each twin pair) must exist in the target's corpus.
 * 2. Snippet validation — EXISTENCE, not retrievability (plan ruling 6).
 *    Per unique expected doc, one question-based retrieval call with
 *    cite_doc_ids and the reranker OFF / pools widened
 *    (SNIPPET_LOOKUP_KNOBS); a snippet contained in any returned chunk is
 *    existence-proven. A snippet the question lookup MISSES gets its own
 *    doc-scoped lookup whose query is derived from the snippet itself
 *    (first 48 code points of its trimmed text) — if THAT contains it, the
 *    snippet exists and the miss is recorded as a rank gap (informative,
 *    never fatal); only a miss on both lookups is a snippet failure.
 *
 *    Why the derived query must never be the case question: a
 *    question-based gate conflates "the fixture is broken" with "retrieval
 *    does not rank this chunk for this question". Measured 2026-09-08 on
 *    the trucks doc: an English question surfaced only ~134 of the doc's
 *    406 chunks (the zh ES-summary chunk did not make the cut; a query
 *    built from the snippet's own text ranked it #1) — 36 false
 *    "failures" from cross-lingual ranking alone.
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

/** The existence lookup's query: the first 48 code points of the trimmed
 * text_snippet — deterministic, no language detection (the wide-pool
 * doc-scoped lookup makes rank irrelevant; only determinism matters).
 * Never the case question — see the header. 48, not more, because a short
 * verbatim prefix maximizes bm25/dense hit on the exact chunk while staying
 * long enough to be distinctive; Array.from iterates code points, so
 * astral-plane snippets (emoji) cannot split a surrogate pair. */
const EXISTENCE_QUERY_CODEPOINTS = 48

function existenceQueryFor(textSnippet: string): string {
  return Array.from(textSnippet.trim())
    .slice(0, EXISTENCE_QUERY_CODEPOINTS)
    .join('')
}

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
  /** Only the call estimate depends on this: no-selection derives each
   * case's selection with one extra cite retrieval (once per run). */
  selectionMode?: 'fixture-set' | 'no-selection'
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

  // (2) Snippet validation — existence, not retrievability. Per unique
  // expected doc: one question-based lookup (the rank-gap probe), then a
  // snippet-derived lookup for each snippet the question missed (the
  // existence gate). cite_doc_ids restricts every lookup to that doc's
  // chunks; SNIPPET_LOOKUP_KNOBS keeps the reranker (and its caps) out of
  // the way.
  const snippet_failures: PreflightReport['snippet_failures'] = []
  const rank_gaps: PreflightReport['rank_gaps'] = []
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
      for (let i = 0; i < passages.length; i++) {
        const p = passages[i]
        // Contained in the question lookup's chunks → existence proven.
        if (
          outcome.chunks.some((ch) => snippetContained(p.text_snippet, ch.text))
        ) {
          continue
        }
        // The question missed it → the existence gate: a lookup whose
        // query is derived from the snippet's own leading text.
        const query = existenceQueryFor(p.text_snippet)
        if (query === '') {
          snippet_failures.push({
            case_id: c.id,
            doc_id: docId,
            reason: `snippet ${i + 1} has an empty text_snippet`,
          })
          continue
        }
        let existence
        try {
          existence = await target.retrieve(query, {
            cite_doc_ids: [docId],
            ...SNIPPET_LOOKUP_KNOBS,
          })
          if (existence.cost_usd != null) {
            lookupUsd += existence.cost_usd
            lookupCalls++
          }
        } catch (e) {
          snippet_failures.push({
            case_id: c.id,
            doc_id: docId,
            reason: `existence retrieval failed: ${(e as Error).message}`,
          })
          continue
        }
        if (existence.chunks.length === 0) {
          snippet_failures.push({
            case_id: c.id,
            doc_id: docId,
            reason: 'no chunks returned for doc',
          })
          continue
        }
        if (
          existence.chunks.some((ch) =>
            snippetContained(p.text_snippet, ch.text),
          )
        ) {
          // Exists — the question just did not surface it.
          rank_gaps.push({
            case_id: c.id,
            doc_id: docId,
            snippet_index: i,
          })
        } else {
          snippet_failures.push({
            case_id: c.id,
            doc_id: docId,
            reason: `snippet ${i + 1} not contained in any returned chunk`,
          })
        }
      }
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
  // Each case×pass spends one retrieval and one synthesis call.
  // no-selection derives each case's selection with one extra cite query
  // (once per run, not per pass).
  const citeCalls = args.selectionMode === 'no-selection' ? cases.length : 0
  // Judge items: per case×pass, 1 fact-recall + 1 per (estimated)
  // sentence + 1 unsupported.
  const estimated_calls = {
    retrieval: cases.length * passes + citeCalls,
    synthesis: cases.length * passes,
    judge: judgeCfg
      ? cases.reduce((sum, c) => sum + passes * (2 + estimateSentences(c)), 0)
      : 0,
  }

  const report: PreflightReport = {
    corpus_ok,
    missing_docs,
    snippet_failures,
    rank_gaps,
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
  for (const g of rank_gaps) {
    console.log(
      `[preflight] rank gap: ${g.case_id} / ${g.doc_id}: snippet ` +
        `${g.snippet_index + 1} exists but the question lookup did not surface it`,
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
