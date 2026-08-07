# Answer-Eval Rewrite Implementation Plan

> **STATUS 2026-07-23 — Tasks 1 and 2 are DONE; Tasks 3 and 4 remain.**
> - **Task 1 (chunk-ID remap): DONE — PR #257.** Record:
>   `docs/research/2026-07-23-answer-golden-remap.md`. ans_002 went 0% ->
>   26.7/28.6 at chunk level. No manual relabel was needed (min overlap 34.1%).
>   One addition not anticipated here: expected_passages were deduped 190 -> 178,
>   because re-chunking collapsed 12 formerly-distinct passages into shared
>   chunks and duplicate expected `chunk_id`s inflate `tp` against an
>   un-inflated denominator.
> - **Task 2 (answer per-doc rerank cap): DONE — PR #255.**
>   `answer_rerank_per_doc_cap`, default `None` (no behaviour change).
> - **Tasks 3 (cap A/B) and 4 (re-validation) NOT started.** ans_006 doc-F1 is
>   **28.6** on the remapped set — the A/B target is unchanged and now cleanly
>   measurable.
> - Note the prerequisite below is satisfied differently than written: #250 is
>   still open, so #257 was branched from it rather than from qa. **Merge #250
>   before #257.**

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the answer-mode retrieval eval trustworthy again — regenerate its stale chunk-level ground truth, and decide (via A/B) whether answer mode needs a per-doc candidate cap to fix the embed-v4 single-doc concentration regression (ans_006).

**Architecture:** Two independent work streams. (1) A *data* fix: the answer golden set's expected `chunk_id`s are positional (`doc_id_chunk_N`) and were renumbered by the 2026-07-22 Mistral reparse, so all 9 cases have broken chunk-level metrics; regenerate them against the current corpus with the existing remap script, hand-relabelling passages whose snippet text no longer matches. (2) A *code + experiment* fix: add a configurable answer-mode per-doc rerank cap (default `None` = no behavior change), then A/B it to decide whether capping recovers ans_006's doc-F1 without regressing other queries.

**Tech Stack:** TypeScript/tsx eval harness (`evaluation/`, Jest for unit tests), Python FastAPI search-service (`search-service/`, pytest), local Mistral-parsed + cohere-embedded corpus via `./scripts/local-bootstrap.sh`.

---

## Prerequisites & coordination (READ FIRST)

- **Hard dependency on PR #250 — currently OPEN, being held until Phase C lands** (to avoid a concurrent qa deploy). #250 carries the chunk-precision double-count fix + `assertChunkMetricsValid` tripwire in `evaluation/lib/metrics.ts`, and this plan's eval runs + the Task 2 `assertChunkMetricsValid` import both require it. **Do not start this plan until #250 is merged to qa; then branch from qa.** If you must start before #250 merges, branch from `fix/eval-harness-corrections` instead of `qa` (that branch is the only place the fix + tripwire currently exist) — but prefer waiting for the merge so you're not building on an un-merged base.
- **Corpus target — the load-bearing constraint.** The answer eval calls `LLAMAINDEX_SERVICE_URL` (default `http://127.0.0.1:8000` — the *local* search service; `evaluation/lib/service-client.ts:17`). Chunk IDs are determined by *chunking*, which changes on *re-parse*, NOT on the embed cutover. The **local** corpus is already Mistral-parsed (final chunking as of 2026-07-22), so the remap (Task 1) runs against it **now** and is **not** blocked on Phase C. ⚠️ If you ever point the eval at the **deployed** corpus, the deployed corpus is still pypdf-parsed until Phase D (Mistral flip) — you must re-run the remap *after* Phase D, because its chunk IDs will differ again.
- **`config.py` merge coordination.** Task 2 edits `search-service/app/config.py`, the same file Phase C's floor re-derivation and the rerank-region flip touch. Land Task 2 on its own branch and merge-order it *after* Phase C's config PR (different lines → likely clean 3-way merge, but sequence to be safe). Do NOT run this plan's local search service while a Phase C operator is mid-cutover if you share a machine — Phase C targets deployed qa, this targets local :8000, so they don't collide on the service, but keep `evaluation/results/` writes from interleaving.
- **Deploy note:** everything here is `evaluation/` + `config.py` + docs. `evaluation/**` is NOT in `deploy-qa.yml`'s `paths-ignore`, so a merge to qa triggers a full deploy — merge in a clean window, not while another deploy (e.g. Phase C's) is running (no `concurrency:` guard exists).

## Context for an engineer new to this code

- **Answer golden set:** `evaluation/answer-golden-dataset.json`. Shape: `test_cases[]`, each with `id`, `question`, `retrieval_ground_truth.{expected_passages[], expected_doc_ids[]}`, `synthesis_ground_truth`. Each `expected_passages[]` entry = `{doc_id, chunk_id, page, text_snippet}`. 9 cases.
- **Why chunk IDs break:** `search-service/app/indexing.py:360` builds `chunk_id = f"{doc_id}_chunk_{chunk_idx}"` — purely positional over `SentenceSplitter(chunk_size=400)` output. Any re-parse renumbers every chunk. Doc-level ground truth (`expected_doc_ids`) survives re-chunking; chunk-level does not.
- **Remap script (already exists):** `evaluation/map-passages-to-chunks.ts`. Flags: `[--input path] [--output path] [--remap]`. Default maps only passages missing a `chunk_id`; `--remap` re-maps ALL. It queries the hybrid service per `doc_id`, scores each candidate chunk by `textOverlapScore(text_snippet, chunk.content)` (Jaccard + containment, [0,1]), and writes back `chunk_id`/`page`. A low top overlap (< ~0.3) means the snippet text no longer appears verbatim (Mistral OCR reformatted it) → that passage needs manual relabel, not just remap.
- **Per-doc rerank cap (already exists for cite):** `search-service/app/bedrock_rerank.py` `BedrockReranker(top_n, per_doc_cap=None)`; `_select_candidates()` fills candidate slots in fusion order but caps each doc at `per_doc_cap` chunks, backfilling leftovers. `search-service/app/main.py:436-438` builds `reranker_answer = BedrockReranker(top_n=20)` (cap `None`) and `reranker_cite = BedrockReranker(top_n=1000, per_doc_cap=settings.cite_rerank_per_doc_cap)` (=2, `config.py:100`).
- **ans_006 regression:** post embed-v4 cutover, all 15 retrieved chunks for ans_006 came from one doc (`2024_accelerating-nature-based-solutions-in-brazilian_3331`), dropping its doc-F1 and ~2/3 of the whole answer-eval aggregate drop (85.8→75.6). A looser answer cap (candidate 3–4, vs cite's 2) is the hypothesis to fix it.
- **Running the eval:** `npm run eval:answer-retrieval` (search-service must be running on :8000). `EVAL_LABEL=<name>` tags the output JSON in `evaluation/results/`. Start the service per CLAUDE.md: `cd search-service && ./venv/bin/python -m app.main`.

---

## Task 1: Regenerate answer golden-set chunk IDs against the current corpus

**Files:**
- Modify: `evaluation/answer-golden-dataset.json` (chunk_ids/pages rewritten in place)
- Backup: `evaluation/answer-golden-dataset.backup-20260722.json`
- Doc: `docs/research/2026-07-22-answer-golden-remap.md` (decisions log)

- [ ] **Step 1: Confirm the local service serves the current (Mistral-parsed) corpus.**
  Run: `curl -s http://127.0.0.1:8000/health | python3 -m json.tool | grep -E "documents_count|dense_lane|status"`
  Expected: `status: healthy`, `documents_count` ~172 (informational, not an exact gate — it drifts with corpus edits), dense lane live. If not running: `cd search-service && ./venv/bin/python -m app.main` (leave running).

- [ ] **Step 2: Back up the current golden set (reversibility).**
  Run: `cp evaluation/answer-golden-dataset.json evaluation/answer-golden-dataset.backup-20260722.json`

- [ ] **Step 3: Dry-run the remap to a scratch file and capture overlap scores.**
  Run: `npx tsx evaluation/map-passages-to-chunks.ts --remap --output /tmp/answer-golden-remapped.json 2>&1 | tee /tmp/remap.log`
  Expected: per-passage lines with a chosen `chunk_id` and an overlap score. No crash.

- [ ] **Step 4: Triage low-overlap passages (< 0.3).**
  Run: `grep -iE "WARNING|Low overlap" /tmp/remap.log` (the script emits its own `WARNING: Low overlap score` lines, correctly thresholded at < 0.3; don't grep for `0.2x` — it logs percentages like `overlap: 23.4%`).
  For each passage whose best overlap < 0.3: open the doc's chunks (query the service for that `doc_id`), find the chunk that actually contains the intended content, and update that passage's `text_snippet` (to current OCR text) + `chunk_id` by hand in `/tmp/answer-golden-remapped.json`. If the content is genuinely gone, drop the passage and note it. Record every manual decision in `docs/research/2026-07-22-answer-golden-remap.md`.

- [ ] **Step 5: Apply the reviewed remap over the golden set.**
  Run: `cp /tmp/answer-golden-remapped.json evaluation/answer-golden-dataset.json`

- [ ] **Step 6: Verify every expected chunk_id resolves and doc IDs are unchanged.**
  Write a one-off check (or extend an existing script) that, for every `expected_passages[].chunk_id`, confirms a chunk with that id exists for that `doc_id` in the corpus, and that each case's `expected_doc_ids` set is byte-identical to the backup's. Run it; expected: 0 unresolved chunk_ids, 0 doc-id diffs.
  Run: `python3 -c "import json; a=json.load(open('evaluation/answer-golden-dataset.json')); b=json.load(open('evaluation/answer-golden-dataset.backup-20260722.json')); assert [ [d for d in tc['retrieval_ground_truth']['expected_doc_ids']] for tc in a['test_cases'] ] == [ [d for d in tc['retrieval_ground_truth']['expected_doc_ids']] for tc in b['test_cases'] ], 'doc ids changed'; print('doc ids stable')"`

- [ ] **Step 7: Commit.**
  Run: `git add evaluation/answer-golden-dataset.json evaluation/answer-golden-dataset.backup-20260722.json docs/research/2026-07-22-answer-golden-remap.md`
  `git commit -m "fix(eval): remap answer golden-set chunk IDs to current Mistral-parsed corpus"`

---

## Task 2: Add a configurable answer-mode per-doc rerank cap (default None)

Use @superpowers:test-driven-development. Default `None` preserves today's behavior, so this is safe to land before the A/B decides a value.

**Files:**
- Modify: `search-service/app/config.py:100` (add field next to `cite_rerank_per_doc_cap`)
- Modify: `search-service/app/main.py:436` (pass the setting into `reranker_answer`)
- Test: `search-service/tests/test_bedrock_rerank.py` (new test)

- [ ] **Step 1: Write the failing test.**

`init_rerankers()` reads the **module-level** `settings = get_settings()` bound once at import (`main.py:90`), and `tests/test_bedrock_rerank.py` already imports `app.main` at collection time — so `monkeypatch.setenv` + `get_settings.cache_clear()` would NOT reach it. Patch the already-imported settings object's attribute directly instead (monkeypatch auto-reverts between tests, so the default test needs no setup):

```python
def test_answer_reranker_uses_configured_per_doc_cap(monkeypatch):
    import app.main as main
    monkeypatch.setattr(main.settings, "answer_rerank_per_doc_cap", 3)
    reranker_answer, _reranker_cite = main.init_rerankers()
    assert reranker_answer.per_doc_cap == 3


def test_answer_reranker_defaults_to_no_cap():
    import app.main as main
    reranker_answer, _ = main.init_rerankers()
    assert reranker_answer.per_doc_cap is None
```

- [ ] **Step 2: Run to verify it fails.**
  Run: `cd search-service && ./venv/bin/python -m pytest tests/test_bedrock_rerank.py -k per_doc_cap -v`
  Expected: the "configured" test ERRORS with `AttributeError` (the `answer_rerank_per_doc_cap` field doesn't exist on settings yet). After Step 3 adds the field, re-run: it should FAIL asserting `per_doc_cap == 3` gets `None` only if the wiring (Step 4) is missing — i.e. add the config field, watch the test fail on the assertion, then wire main.py.

- [ ] **Step 3: Add the config field.**
  In `search-service/app/config.py`, beside `cite_rerank_per_doc_cap: int = 2`:
```python
    # Answer mode leaves this None by default (best chunks wherever they
    # live). Set > 0 to diversify the reranker candidate pool when embed-v4
    # concentrates a query's top chunks in one doc (ans_006). Tuned via the
    # answer per-doc-cap A/B (docs/research/2026-07-22-answer-per-doc-cap-ab.md).
    answer_rerank_per_doc_cap: int | None = None
```

- [ ] **Step 4: Wire it into the answer reranker.**
  In `search-service/app/main.py:436`, change `reranker_answer = BedrockReranker(top_n=20)` to:
```python
    reranker_answer = BedrockReranker(
        top_n=20, per_doc_cap=settings.answer_rerank_per_doc_cap)
```

- [ ] **Step 5: Run to verify it passes (and nothing else broke).**
  Run: `cd search-service && ./venv/bin/python -m pytest tests/test_bedrock_rerank.py -v`
  Expected: PASS, all green, no warnings.

- [ ] **Step 6: Commit.**
  Run: `git add search-service/app/config.py search-service/app/main.py search-service/tests/test_bedrock_rerank.py`
  `git commit -m "feat(search): configurable answer-mode per-doc rerank cap (default off)"`

---

## Task 3: A/B the answer per-doc cap and decide the default

Experiment, not TDD — produces a decision + a results doc. Requires the remapped golden set (Task 1) and the config field (Task 2). Restart the service between runs (settings are read at startup).

**Files:**
- Doc: `docs/research/2026-07-22-answer-per-doc-cap-ab.md`
- Possibly modify: `search-service/app/config.py` (set the winning default)

- [ ] **Step 1: Baseline (cap off).**
  Ensure `ANSWER_RERANK_PER_DOC_CAP` is unset; start the service; run:
  `EVAL_LABEL=answercap-off npm run eval:answer-retrieval`
  Record aggregate doc-F1 and the per-query doc-F1 for **ans_006** specifically.

- [ ] **Step 2: Candidate cap=3.**
  Stop the service, `export ANSWER_RERANK_PER_DOC_CAP=3`, restart, run:
  `EVAL_LABEL=answercap-3 npm run eval:answer-retrieval`

- [ ] **Step 3: Candidate cap=4.**
  Same with `ANSWER_RERANK_PER_DOC_CAP=4`, label `answercap-4`.

- [ ] **Step 4: Compare and write up.**
  In `docs/research/2026-07-22-answer-per-doc-cap-ab.md`, table aggregate doc-F1 + ans_006 doc-F1 for off/3/4, and flag any *other* query that regressed under a cap. Chunk-level metrics are now trustworthy (Task 1) — include chunk-F1 too, and confirm `assertChunkMetricsValid` never tripped.

- [ ] **Step 5: Decide and (if a cap wins) set the default.**
  If a cap improves aggregate doc-F1 AND recovers ans_006 with no material regression elsewhere, set `answer_rerank_per_doc_cap` default to the winner in `config.py`; otherwise leave `None` and record why. Commit the results doc (+ the config default change if any).
  Run: `git add docs/research/2026-07-22-answer-per-doc-cap-ab.md search-service/app/config.py`
  `git commit -m "docs(eval): answer per-doc-cap A/B result + chosen default"`

---

## Task 4: Full re-validation and baseline record

**Files:**
- Doc: `docs/plans/2026-07-22-multilingual-v3-todos.md` (tick the answer-eval items), `docs/research/2026-07-22-answer-golden-remap.md`

- [ ] **Step 1: Run the full answer eval with the final golden set + chosen cap.**
  Run: `EVAL_LABEL=answer-rewrite-final npm run eval:answer-retrieval`
  Expected: no tripwire throw; chunk-F1 now non-zero and meaningful across cases (esp. **ans_002**, previously 0 in every run); doc-F1 at/above the pre-cutover 85.8 if the cap landed.

- [ ] **Step 2: Record before/after.**
  Note the final numbers vs the 75.6 post-cutover / 85.8 pre-cutover reference in the results doc, and check off the "Answer mode" + "Eval infrastructure" items in the todos doc with a pointer to the PR.

- [ ] **Step 3: Commit.**
  Run: `git add docs/plans/2026-07-22-multilingual-v3-todos.md docs/research/2026-07-22-answer-golden-remap.md`
  `git commit -m "docs(eval): answer-eval rewrite validated — record before/after"`

---

## Open decisions for the human

1. **Eval corpus target** — this plan runs against the local Mistral-parsed corpus (the eval default). If you want deployed-parity numbers, that waits for Phase D (deployed Mistral reparse), then re-run Task 1's remap.
2. **Cap value** — 3 vs 4 vs off is decided by Task 3's A/B, but the final call (favor synthesis breadth vs raw chunk precision) is a product judgment.
3. **Low-overlap passages (Task 1 Step 4)** — relabel to current OCR text vs drop the passage. Default: relabel if the content still exists in the doc; drop only if genuinely absent.
4. **Should the answer synthesis (not just retrieval) golden set also be redone?** Out of scope here — this plan covers `retrieval_ground_truth` only. `synthesis_ground_truth` is a separate effort if needed.
