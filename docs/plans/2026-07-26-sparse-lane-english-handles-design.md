# Sparse-lane cross-lingual reach — English handles design (2026-07-26)

**Status:** DRAFT — pending review
**Branch:** `design/cross-lingual-retrieval` (worktree `.worktrees/multilingual-v3`)
**Predecessors:** `docs/research/2026-07-24-cross-lingual-findings.md` (measurements),
`docs/plans/2026-07-24-session-postmortem-and-handoff.md` (process rules),
`docs/plans/2026-07-24-cross-lingual-retrieval-design.md` (bridge design — superseded by this doc).

## 0. Goal and evidence posture

Improve English-query → non-English-document reach through the sparse BM25 lane,
**without** a validated multilingual golden set, under a latency-first constraint.

Agreed gating standard (2026-07-26 session): the English cite golden set
(`npm run eval:cite`) and answer set (`npm run eval:answer-retrieval`) are hard
no-regression gates; directional benefit is read from probes. Because every
non-English measurement we have is small-N (10–17 pairs) and agent-authored,
**probe numbers justify direction, never thresholds**. Design consequence:
every shipped change is cheap, reversible, flag-gated, and adds zero
query-time latency. The one latency-bearing mechanism (a translated query
lane) is deferred behind a measurement gate (§4).

## 1. Verified facts this design rests on

All verified this session unless noted. File:line references are to the
worktree at commit `d597808`.

| # | Fact | Evidence |
|---|---|---|
| F1 | The sparse query is a flat bag of words: `" OR "` separators tokenize away (English stopword), and the query vector is token counts (`counts[i-1] += 1.0`) | `app/pg_store.py:174-187`, `app/sparse_keyword.py:32-45` |
| F2 | Both dense embed and sparse weights consume chunk text **prefixed with a metadata header** including `title` — the native title for es/pt/id docs | `scripts/build_sparse_keyword.py:57`, `worker/stages/embed.py:76,186`; findings §2.2 |
| F3 | zh chunks already carry an English title handle (English catalog title + slug); es/pt/id carry none. Measured: docs with an English handle score bm25 rank 1–15, without 38–93 or miss | findings §2.2 (measured 2026-07-24) |
| F4 | The summary chunk indexes the **native** long summary (`WHERE language = doc.language AND kind='long'`); the 29/29 curated English long summaries are indexed nowhere | `worker/stages/embed.py:160-163`; findings §2.4 |
| F5 | **Chinese is structurally unreachable by sparse body matching**: the tokenizer emits one token per punctuation-bounded clause (probe 2026-07-26: `零排放物流车队如何实现货运脱碳` → 1 token). Query translation to zh cannot help the sparse lane. es/pt tokenize normally | tokenizer probe run against `app/sparse_keyword.py` parameters; scratchpad `zh_tokenize_probe.py` |
| F6 | Single-lane query translation costs cite recall 83.3 → 76.5 (P8) because RRF is rank-based: translated terms push English chunks down the one sparse ranking | findings §3.2, §4 |
| F7 | The `return_intermediate_results` diagnostic does not reproduce the real sparse lane (raw query instead of expanded; `bm25_top_k` never applied) | `app/main.py:924-926` vs `app/main.py:216-219,238` |
| F8 | The 12 `en-topical` probes ARE filed (`evaluation/cross-lingual-en.json`, class marked PROVISIONAL) — findings §7 "not yet filed" is stale — but **no runner consumes the file** | grep of `evaluation/*.ts`, 2026-07-26 |
| F9 | Presentation is NOT fixed: `titleFrom` resolves native titles (`utils.tsx:159-164` on origin/qa), no language label is rendered anywhere. English abstracts DO render (`CitePanel.tsx:92-94`) — that half was never broken. All CSV metadata keys survive to the client in `CatalogRow.raw` (`utils.tsx:76-87`), so a language badge is frontend-only; `title_en` is absent client-side and needs plumbing | origin/qa, verified 2026-07-26 |
| F10 | 3 es docs have a Spanish `title_en` (`_3254`, `_2276`, `_9425`), provenance `'llm'` (overwritable) | findings §2.3 |
| F11 | Adding a chunk to a document is not monotone under `cite_rerank_per_doc_cap` + max-over-chunks scoring — the trap that parked the bridge. This design adds **no chunks** | findings §5 "Reranking and scoring" |

## 2. Layer 0 — instruments, hygiene, presentation (no retrieval risk)

Ship first, in any order. None of these touch retrieval rankings.

**L0.1 Diagnostic parity.** Make the `return_intermediate_results` sparse
diagnostic use `build_sparse_query` (same expansion the fusion path applies)
and apply `request.bm25_top_k`, so per-lane attribution from probes is valid
(fixes F7). Dense diagnostic is already at parity.

**L0.2 Probe runner.** A small tsx runner (`evaluation/` convention) that
reads `cross-lingual-en.json`, issues `/query` per query with pinned
parameters (single harness — postmortem rule 7), and reports per-class target
presence/rank plus english_competitor displacement. Output is a BEFORE/AFTER
delta report, deliberately without pass/fail thresholds (n=27 justifies
direction, not thresholds — the file's own caveat).

**L0.3 Data hygiene.** Repair the 3 Spanish `title_en` values (F10;
provenance `'llm'` permits overwrite; audit-logged path). Annotate the two
known-defective smoke queries (`nq-pt-02`, `nq-es-01` targets are
`language='en'` on qa — findings §6) so runners can exclude them.

**L0.4 Language badge (frontend-only).** Render a language label on result
rows from the client-side catalog (`CatalogRow.raw` already carries the CSV
`languages` value — F9). Zero retrieval risk, addresses the verified
presentation gap (native headline with no language indication).
`title_en` *display* requires new plumbing (DB → API or CSV → client) and is
explicitly deferred — it is a separate small design, not part of this one.

## 3. Layer 1 — English handles into sparse weights (the mechanism)

### 3.1 What

For every document with `language != 'en'`, inject English handle text into
the **sparse weight computation only**:

- **Every chunk:** append `documents.title_en` (skip when it equals the
  already-indexed title, e.g. most zh docs — F3).
- **The summary chunk** (`chunk_index = -1`): additionally append the English
  long summary (`document_summaries` row `language='en', kind='long'`).

This generalizes the mechanism the corpus already proves: zh docs are
reachable *because* their chunks carry English title vocabulary (F3), and it
is the only sparse-lane route that can ever help zh (F5). Dense embeddings,
chunk text, `document_texts`, and the `/query` contract are untouched. No new
chunks (F11 trap avoided). No query-time cost.

### 3.2 Where

Two write sites, both flag-gated by a new setting `sparse_en_handles: bool`
(default **false**) in `app/config.py`:

1. **`scripts/build_sparse_keyword.py`** — when building `contents`
   (currently `get_content(MetadataMode.EMBED)`, line 57), append the handle
   text for qualifying chunks. Requires joining `documents`
   (`language`, `title_en`) and `document_summaries` (en/long) into the chunk
   load. The rebuild is self-consistent: dl, avgdl, df/idf all recomputed
   over the injected corpus in one transaction.
2. **`worker/stages/embed.py`** — the incremental sparse write for
   re-ingested docs must apply the same injection before `chunk_weights`, or
   the next re-ingest silently strips the handles (drift). Same source data,
   same flag.

Query side (`SparseKeywordRetriever`) is unchanged. `KEYWORD_BACKEND=memory`
is unchanged (it hydrates from raw chunk text) — flag off + one rebuild
restores byte-identical current behavior, and `memory` remains the deep
rollback.

### 3.3 Interactions

- **`scripts/sparse_parity_check.py`** asserts sparse ≡ in-memory BM25 over
  raw text; with the flag on this is expected to diverge. The check must be
  run flag-off, or taught to apply the same injection. Called out so a CI or
  manual parity run is not misread as a regression.
- **Frozen-stats policy** unchanged: a full `build_sparse_keyword.py` run is
  the deploy step (~1–2 min, worker idle — existing runbook rule).
- **Floor re-derivation** required per existing policy
  (`app/config.py:137-143`): any candidate-pool change moves the cite floor.
  `capture_cite_scores.py` + `analyze_cite_scores.py`, same as prior changes.

### 3.4 Gates (in order)

1. `npm run eval:cite` and `npm run eval:answer-retrieval` — no regression,
   both arms on the identical harness (postmortem rule 7).
2. L0.2 probe runner BEFORE/AFTER on all three classes. Directional claims
   only. `en-body` is expected NOT to move (it was authored to avoid
   title/abstract vocabulary — that immunity is by construction, findings §6);
   the signal classes for this mechanism are `en-topical` and `en-tr`.
3. Floor re-derivation, then re-run gate 1 at the new floor.
4. Competitor displacement check from the probe report: english_competitors
   in `en-topical` must not systematically lose top-10 positions.

**Rollback:** flag off + rebuild (minutes). No schema change, no data loss.

## 4. Layer 2 — deferred: translated sparse lane (decision point, not scope)

Re-open only if Layer 1's AFTER probes still show es/pt **body-level** misses
(the P5-class wins translation uniquely provides). Recorded design
constraints, so the next session does not re-derive them:

- **Own RRF lane** (dense + sparse-en + sparse-translated), never the single
  shared query — F6 is the disqualifier for the shared lane.
- **es/pt only.** zh translation is provably useless to sparse (F5); id
  optional (1 doc).
- **Translation source, latency-first, in preference order:**
  1. *Precomputed term dictionary* (offline batch from `keyword_vocab`
     vocabulary + LLM; deterministic, zero in-path calls) — findings §8
     already named this option.
  2. *Small hosted model on Bedrock* (user direction 2026-07-26): candidates
     are Amazon Nova Micro/Lite, Claude Haiku 4.5, or serverless Qwen3-32B
     (fully managed on Bedrock since 2025-09, us-east-1, ~$0.15/1M input) —
     or a qmd-style small fine-tuned Qwen via Bedrock Custom Model Import.
     Requires a latency spike proving p50 well under the ~3s the gpt-5-mini
     call measured (findings §5 Operational); target ≤ ~500ms with the
     existing LRU cache and failure-soft degradation (`query_translate.py`
     already implements both).
     A *self-hosted local* model remains excluded by the v3 all-Bedrock
     decision; revisiting that is a named decision for the user, not a
     default.
- **Unsolved and still blocking:** the translated lane's RRF weight cannot be
  derived without an instrument that sees cost and benefit together
  (findings §6). This is why Layer 2 is a decision point and not scope.

## 5. Out of scope / parked (with reasons)

- **English-bridge chunks** — parked, not refuted; simulation specified but
  never built; F11 trap (predecessor design doc).
- **RRF k / top-rank bonus / position-aware rerank blending** (qmd ideas) —
  English-quality fusion tuning, un-gateable without a golden set.
- **Rerank-candidate quotas / larger rerank window** — insurance for a 10×
  corpus; not a today-problem; rerank dominates the latency budget
  (`app/config.py:113-116`).
- **BGE-M3 learned sparse weights** — natively multilingual and the
  `document_chunks.sparse` column was designed for it, but self-hosted
  (excluded by the v3 all-Bedrock decision).
- **`title_en` display plumbing** — separate small design (L0.4 note).
- **Non-English *queries*** — different usage pattern; `non-english-smoke.json`
  covers the existing behavior.

## 6. Sequencing

1. L0.1 + L0.2 (instrument first — nothing is measurable honestly without them)
2. L0.3 + L0.4 (hygiene + badge, parallelizable)
3. BEFORE probe capture (L0.2 output archived)
4. Layer 1 behind flag; local qa-RDS-read-only probe rig as on 2026-07-24
5. Gates §3.4; ship flag-on via the normal qa deploy path
6. Layer 2 decision from the AFTER report — explicitly a stop-and-decide point
