# Intelligent Query Expansion & Understanding — Design (2026-08-19)

**Branch:** `feature/query-expansion` (worktree `.claude/worktrees/feature-query-expansion`, based on `qa`)
**Status:** Design approved in brainstorm 2026-08-19; implementation plan to follow.
**Goal:** Improve precision, recall, and user trust on `/query` via query expansion,
facet detection, intent sensing, and did-you-mean disambiguation — full loop, API + UI.

Filed in `docs/plans/` per repo convention.

Companions:
- `docs/plans/2026-07-24-cross-lingual-retrieval-design.md` — the separate-lane lesson,
  rerank-window displacement mechanism, §5.2 lane-attribution instrument this design requires.
- `docs/superpowers/specs/2026-08-17-issue-323-topic-taxonomy-design.md` — the tag
  substrate (`tags`, `tag_aliases`, `tag_embeddings`) this design consumes; its deferred
  workstreams C (retrieval integration) and D (query topic sensing) land here.
- `search-service/app/query_expansion.py` — prior art being partially retired (§5.3).

---

## 1. Problem

Observed failure modes (all confirmed by the owner, 2026-08-19):

1. **Recall misses from vocabulary gap** — user words don't match corpus terminology
   (the known LVC drift: golden docs that never reach the reranker at all).
2. **Precision noise** — broad queries drown good results in loosely-related chunks.
3. **Ambiguous/underspecified queries** — the system silently guesses one reading.
4. **Constraint blindness** — implicit facets ("since 2022", "in Portuguese", "latest
   report on…") are ignored; nothing parses query text into filters. Today even the
   explicit `min_year`/`max_year`/`required_program` params filter **post-rerank** in
   Python (`main.py` stage 2.5), wasting rerank slots on discarded docs.
5. **Missing non-EN documents on topical queries** — tracked here only as a protected
   invariant; the sparse-lane non-EN work is its own exploration (§9).

Current `/query` has zero LLM calls; the only query preprocessing is the hardcoded
`DOMAIN_EXPANSIONS` OR-stuffing into the single sparse lane.

## 2. Design values

Stated by the owner: maximize user delight and **trust**; simplicity in the UX above
all; avoid brittleness where complexity breeds silent failures.

### The two invariants (govern every mechanism below)

1. **Anything that excludes documents must be visible and reversible. Anything that
   only reorders may be silent.** Expansion variants, topic boosts, reranking — silent.
   Filters — always a removable chip. No code path may quietly hide documents.
2. **Hard filters only on human-verifiable metadata** (year, language, doc type,
   program — facts in the `documents` row). Model-inferred attributes (topic tags,
   intent) may only boost or suggest, never exclude. Inferred-query-facet ×
   inferred-doc-tag hard filtering is where silent recall loss breeds.

## 3. UX surface (four quiet elements, no new pages)

- **Interpretation line.** One line under the search box, rendered only when the system
  actually did something: `Showing: freight decarbonization · 2022–present ✕ · Portuguese ✕`.
  Each chip removable, one click, instant re-query. Removing/editing a chip sends
  **explicit** facets back to the server, which then skips auto-detection entirely —
  once the user touches the chips they are in control and the system stops second-guessing.
- **Did you mean — one suggestion, never a modal.** Single line, one click to swap.
  Shown only when evidence supports it: query term out-of-corpus-vocabulary with a close
  trigram neighbor, or the LLM flags a likely misread AND the alternative retrieves
  visibly stronger (decidable rule: strictly more docs above the relevance floor, or a
  strong-tier result where the original had none). When the original query is
  near-empty (fewer than 3 docs above floor) and the correction is strong,
  auto-switch with the reverse link ("searched for *X* instead · search for *Y* as typed").
- **Ambiguity as alternative readings, not a questionnaire.** Results show immediately
  for the dominant reading, plus tappable alternative-reading chips (from LLM
  disambiguation candidates + tag-embedding neighborhoods). Never a blocking dialog.
- **Empty states that navigate.** When the relevance floor kills everything: "No strong
  matches for *X*. Nearby topics in our library: [chips from tag-embedding proximity]."

**Catalog intent:** queries shaped like "what have we published on hydrogen since
2020?" (a large share of real usage — the eval sets are full of them) get the same cite
results **ordered by date** with year facets applied and chips shown.

Latency posture throughout: nothing blocks on understanding; late understanding simply
doesn't participate in that response.

## 4. Architecture

### 4.1 The understanding sidecar — `search-service/app/understanding.py`

One versioned, schema-validated object per query; the single artifact everything else
consumes:

```
QueryUnderstanding {
  version: int,
  intent: "topical" | "known_item" | "catalog",
  facets: [{facet, value, confidence, source: "parser"|"llm", action: "hard"|"soft"|"suggest"}],
  variants: [str],              # 0–2 alternative phrasings
  suggestions: [{type: "spelling"|"disambiguation"|"nearby_topic", text}],
  timings: {...},
  degraded: [str],              # which signals didn't run and why
}
```

Two tiers feed it:

- **Deterministic tier (always runs, ~0 added latency):**
  - regex/date parsers for year ranges and language names;
  - program / doc-type matching against known `tags` values;
  - `tag_aliases` lookup for vocabulary expansion;
  - pg_trgm spell-check against an offline-built vocabulary (titles + tag labels +
    aliases + high-df corpus terms);
  - topic sensing: cosine of the query embedding (already computed for the dense lane —
    zero extra calls) against `tag_embeddings` (same model, `cohere-embed-v4`, same space).
- **LLM tier (flagged, time-budgeted ~500ms, LRU-cached by query string):** one
  structured call producing variants, facet extraction with confidence, intent, and
  disambiguation candidates. **Model: a small GPT-5.6-class model via the service's
  existing OpenAI path** (client/timeout/failure-soft pattern per `query_translate.py`;
  `OPENAI_API_KEY` already plumbed). Model id is a `config.py` setting — swapping models
  is an env change, not a code change. Explicitly NOT Bedrock/Haiku (owner preference,
  2026-08-19).

### 4.2 Timeline — nothing waits on the LLM

```
t0    fire in parallel: original dense ─┐ original sparse ─┐ sidecar ─┐
t~400 original lanes done               │                  │
      wait_for(sidecar, remaining budget) — if late: fuse originals only, done
t~600 sidecar landed → variant lanes retrieve (parallel, one round)
t~900 multi-lane weighted RRF → facet filter → rerank(original query) → assemble
```

Budget is a `config.py` setting. A sidecar miss costs nothing; a hit costs one extra
parallel retrieval round (~300–400ms) only when variants exist.

### 4.3 Multi-lane weighted RRF

Generalize `HybridFusionRetriever` from fixed {dense, sparse} to a lane list:

- original dense + original sparse at **2× weight**;
- each variant's dense + sparse at 1×;
- alias-expansion lane (deterministic tier) at 1×;
- (future, out of scope here: translated-query lane — this structure is the home the
  2026-07-24 findings demanded).

Same k=60, same node-id dedupe. `expand_query_conservative` OR-stuffing is retired in
favor of the alias lane — same idea, correct mechanics — but only after the P2 gate
passes (§7).

### 4.4 The precision guard

**The reranker only ever sees the original query.** Variants influence which candidates
exist; the cross-encoder judges relevance to what the user actually asked. Expansion can
widen the pool but can never redefine the question. This is the single strongest
structural defense against expansion-induced noise.

### 4.5 One facet application point

Post-fusion, **pre-rerank**. Auto-detected hard facets and user-confirmed chip facets
flow through the same filter function — no second code path. This moves the existing
year/program filters from post-rerank (a correctness improvement: rerank slots stop
being wasted on discarded docs) and is the one behavior change to existing params —
gated in P1. SQL pushdown of facets is a later optimization (P4), noted not built.

Facet → column mapping uses `documents` fields (`year_published`/`date_published`,
`language`, `article_type`) and `tags`/`document_tags` for program — not the chunk
metadata `year` string. Since nodes carry only chunk metadata, this requires extending
the startup doc-metadata hydration (`load_documents_metadata` currently selects only
`external_id, source_metadata`) to include these columns; note the cross-lingual
design's caveat that startup-hydrated metadata needs a service restart to refresh.

### 4.6 Contract (additive only; `QueryRequest`/`QueryResponse` fields untouched)

- `QueryRequest` + optional `facets` (explicit chip state; presence disables auto-apply)
  and `expansion: bool` (eval control, default true).
- `QueryResponse` + `query_understanding` (the object above, annotated with what was
  actually applied).
- `route.ts` projects the new block to the UI; the app never interprets queries, the
  service never renders.

## 5. Failure posture — every failure degrades to today's behavior, provably

- Sidecar timeout, LLM error, schema-validation failure, missing `tag_embeddings`
  (cold start), pg_trgm unavailable — each independently nulls its contribution;
  `understanding.degraded` records which. With everything degraded the pipeline must be
  **byte-identical to the flag-off path**, and a test asserts exactly that (the
  `build_sparse_query` discipline: the flag is a true no-op when off).
- No retry loops in the query path: one attempt, one budget, miss means skip.
- LLM structured output is validated strictly; any unknown facet name or out-of-range
  confidence rejects the **whole object** rather than half-applying it.

## 6. Observability — silent failure is banned

Extend `_emit_query_emf`:
- sidecar latency, timeout rate, degraded-signal counts;
- per-facet applied/suggested/removed-by-user counts (chip removals are ground truth
  that auto-detection was wrong);
- per-lane contribution of each variant lane — requires the per-lane rank attribution
  in `debug` (the §5.2 instrument from the cross-lingual design; P0 here).
- Did-you-mean shown/accepted flows through the existing feedback layer.

## 7. Phasing — five flags, each dark, each gated before the next

| Phase | Ships | Behavior change |
|---|---|---|
| **P0** | Per-lane rank attribution in `debug`; baseline capture of cite + answer golden sets | none |
| **P1** | Deterministic tier + chips UX; single pre-rerank filter point; trigram did-you-mean; empty-state topic rescue | filter point moves pre-rerank (gated) |
| **P2** | Multi-lane weighted RRF; alias lane; retire `DOMAIN_EXPANSIONS` OR-stuffing after gate | sparse lane content (gated) |
| **P3** | LLM sidecar: variants, facet extraction, intent, disambiguation; catalog-mode presentation | flagged |
| **P4** | Tuning + SQL facet pushdown if corpus scale demands | flagged |

**Gates per phase:**
- cite golden set macro recall may not fall;
- answer-retrieval chunk recall may not fall;
- (multilingual document retrieval is protected via the cite golden set, whose
  EN queries already reach non-EN docs; a dedicated non-English-query smoke was
  removed 2026-08-19 — non-English queries are out of scope for this design, §9);
- new labeled sets, small and direction-only: facet-extraction (~30 queries → expected
  facets) and did-you-mean (misspellings + false-positive traps). Confidence thresholds
  for hard-vs-suggest are **derived** from the labeled set, never hand-picked.

**Named regression mechanism:** variant lanes add candidates that can displace golden
docs from the 100-slot rerank window (`rerank_candidates=100`, per-doc caps). The 2×
original weight bounds it; the cite golden gate catches it; the eval runner emits a
per-query "variant lane displaced a golden doc" attribution so failures are diagnosable,
not just detectable.

## 8. Testing

- Byte-identical no-op test for the all-degraded path (P1+ each flag).
- Unit tests per deterministic parser (year/language/program), alias lookup, trigram
  suggester (including false-positive traps).
- Multi-lane RRF: weight math, dedupe, lane-list generalization reproduces current
  two-lane output exactly when given the legacy lane list.
- Sidecar: schema validation rejects malformed output whole; timeout path; cache.
- Facet filter point: pre-rerank application, explicit-facets-override-auto behavior.
- Contract test: `QueryRequest`/`QueryResponse` existing fields byte-stable.

## 9. Out of scope (recorded so the boundary is explicit)

- **Sparse-lane non-EN retrieval** (per-language stemming/segmentation, `summary_en`
  bridge, translated-query lane content) — its own exploration. This design contributes
  only the structural hook: a translated lane is one more entry in §4.3's lane list.
- Retrieval threshold/tier re-derivation, reranker swaps, answer synthesis.
- Facet management UI beyond chips (the admin taxonomy UI is #323's).

## 10. Decision log

| # | decision | when |
|---|---|---|
| 1 | Approach A (understanding sidecar + multi-lane fusion), staged deterministic-first | 2026-08-19 |
| 2 | LLM posture: parallel, non-blocking, best-effort budget | 2026-08-19 |
| 3 | Full loop API + UI in scope | 2026-08-19 |
| 4 | Facets: hard-apply high-confidence + visible removable chips; low-confidence suggest | 2026-08-19 |
| 5 | Sidecar model: small GPT-5.6-class via existing OpenAI path, over Bedrock Haiku | 2026-08-19 |
| 6 | Sparse-lane non-EN work excluded; lane hook only | 2026-08-19 |
