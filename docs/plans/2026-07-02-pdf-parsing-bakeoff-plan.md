# PDF Parsing Bake-off — Plan

**Date:** 2026-07-02
**Status:** Ready to execute
**Workstream:** Retrieval / Document Management — parse stage only
**Brief:** `docs/research/2026-07-02-pdf-parsing-bakeoff-brief.md`
**Prior art:** `docs/research/2026-06-10-sparse-model-bakeoff-brief.md` (same shape: backend swap, eval-gated, no cutover until metrics pass)
**Design alignment:** `docs/plans/2026-06-09-askwri-document-management-design.md` §7.3, §7.5, §11 (ParserProvider), §6 #4 (capture-rich/decide-late)
**As-built reference:** `docs/document-management.md` §3, §10 (ownership, pipeline, deferred `structured` population)
**In-flight dependencies:** `docs/plans/2026-07-02-next-steps-qa-deploy.md` Part 2 (R3 chunk-builder divergence, R4 Chinese page boundaries)

---

## 1. Goal

Decide, **eval-gated**, whether the ingestion worker's parse stage (`search-service/worker/stages/parse.py`) should replace LlamaIndex `PDFReader` (pypdf text-layer extraction) with a layout-aware parser, and if so which one(s) and under what routing. **No production cutover until retrieval metrics pass the gate in §7.**

This is the parse-stage analogue of the sparse-retrieval bake-off. It reuses the repo's proven harness: `evaluation/run-baseline-suite.sh --daemon <label>` with `EVAL_LABEL`-stamped reports.

> **Design alignment note (read first).** The system design *anticipated* this decision: §11 specifies a `ParserProvider.parse(pdf) → {structure, chunks, tables, figures}` interface behind which GROBID + a layout parser sit, and states "swapping a parser is a config change plus re-parse." This bake-off implements that intent. Two design points shape the plan and are called out where they change the approach:
> - **Capture-rich, decide-late (§6 #4):** persist the parser's structured output at ingest so future parser/model changes replay only their stage, not a full re-ingest. The bake-off *measures* candidates by re-parsing, but the production shape is staged replay (§4, Step 0 precondition 5).
> - **Tables/figures as first-class chunks (§7.3):** the design wants `document_chunks` rows with `unit_type='table'|'figure'`, `section_path`, `caption`, `structured` (jsonb). These **columns already exist** in the as-built schema (migration `178128`); the as-built embed stage simply never populates them (it writes only `text`/`summary`). The fuller design path is therefore a **parse+embed-stage change, no schema migration.** This plan offers that as an explicit scope fork (§3, Phase 1a vs 1b), not a silent decision.

---

## 2. Candidates & matrix

The parse stage has two independent dimensions. The bake-off varies **one dimension at a time** (§3).

**Dimension 1 — base parser** (the `_parse_pdf` branch). **This is a scope fork — choose Phase 1a or 1b (§3.1):**
| Label | `PARSE_BACKEND` | Library | Output contract | Notes |
|---|---|---|---|---|
| `parse-pypdf` | `pypdf` | LlamaIndex `PDFReader` (current) | `(full_text, page_boundaries)` | Baseline — no change |
| `parse-docling` | `docling` | `DoclingReader` (MIT, CPU) | Phase 1a: `(full_text, page_boundaries)`; Phase 1b: structured | Primary candidate; layout + tables + its own OCR |
| `parse-llamaparse` | `llamaparse` | `LlamaParse` (cloud) | same contract per phase | Escalation; cost + egress; needs `LLAMAINDEX_API_KEY` |

**Dimension 2 — OCR pre-process** (only for the scanned subset, tested if Docling's OCR is insufficient):
| Label | Pre-process | Then |
|---|---|---|
| `parse-ocrmypdf-pypdf` | `ocrmypdf --skip-text --deskew --rotate-pages -l eng` | unchanged `pypdf` path |

**Not in the matrix** (ruled out in the brief): Marker (GPL), PyMuPDF4LLM (AGPL), Nougat (CC-BY-NC), MinerU (GPU-VLM; consider only if Docling fails and GPU batch is acceptable), GROBID (metadata/references sidecar; separate decision, §9 — note the design §7.5 gives GROBID a **metadata-extraction** role: title/authors/DOI/abstract/sections feeding the metadata store and dedup identity key, broader than "references only").

---

## 3. Experimental design

### 3.1 Scope fork — Phase 1a (minimal text swap) vs Phase 1b (structure-aware chunking)

This is the single most important design decision in the plan and is **not** a foregone conclusion.

- **Phase 1a — minimal text swap.** New parser emits `(full_text, page_boundaries)` exactly as today; the existing 400/80 `SimpleNodeParser` chunker is unchanged; `document_chunks` rows stay `unit_type='text'|'summary'` with `structured`/`section_path`/`caption` NULL. **Smallest blast radius, isolates parse quality, but discards the table/figure structure that is the main reason to adopt a layout parser.** Use this to answer "is the new parser's text/recovery/reading-order better on WRI reports?"
- **Phase 1b — structure-aware chunking (design §7.3).** New parser emits per-page text **and** structured elements (tables, figures, section headings with `section_path`, captions); the embed stage writes `unit_type='table'|'figure'` rows into the already-existing `structured`/`section_path`/`caption`/`unit_number` columns; tables become self-describing chunks (caption + structured cells + short LLM summary, per §7.3). **Realizes the design's first-class table/figure retrieval; larger change to the embed stage and the golden-set chunk references; may move retrieval metrics in ways that confound pure parse quality.**

**Recommendation:** run **Phase 1a first** (clean parse-quality signal), then — only if a parser passes the §7 gate — run **Phase 1b** on the winning parser to measure the structure-aware win. Do not run 1b during the parser *selection* bake-off; run it after, on the chosen parser, as a separate chunking experiment. (Chunker comparison is already out of scope per §3/§10; Phase 1b *is* a chunker change and should be eval-gated separately.)

**One variable at a time.** Phase 1a retrieval runs keep the **chunker constant** (existing 400-char/80-overlap) and feed it each parser's `full_text`, so the only variable is parse quality. Phase 1b is a *separate* chunking experiment on the winning parser (§3.1), not part of parser selection.

**The `/query` contract is untouched.** The parse stage's Phase-1a output contract is `(full_text, page_boundaries)` written to `document_texts` (upsert) — identical to today. Phase 1b additionally writes structured elements into the already-existing `document_chunks` columns (`structured`, `unit_type`, `section_path`, `caption`, `unit_number`); no `QueryRequest`/`QueryResponse` change in either phase.

**Sequencing behind in-flight work.** Two items in `docs/plans/2026-07-02-next-steps-qa-deploy.md` Part 2 directly interact with a parse swap and **must land (or be consciously deferred) first**:
- **R3 (chunk-builder divergence).** The worker's `_build_nodes_for_doc` already diverges from the Phase-0 migration builder in `title` source, `authors` truncation, and `file_path` vs `s3_key` — the exact metadata fields a parser swap touches. Reconcile both builders onto one shared path (or confirm R3 is being deferred) **before** the bake-off, or parse quality will be confounded with pre-existing metadata drift.
- **R4 (Chinese page boundaries).** Boundaries are computed from original text but chunks are OpenCC-normalized (t2s), so length-changing phrases shift later chunks' computed page numbers. A layout parser that emits **per-page text natively** (Docling/LlamaParse do) lets the parse stage emit per-page text and the embed stage use the parser's page labels directly — **structurally fixing R4**. The Phase-1a implementation should support a per-page-text emission mode (not just `\n\n`-joined `full_text`) so R4 is fixed, not inherited.

**Runs are sequential, not parallel.** Each candidate re-parses the same corpus into the same Postgres `document_chunks` table (overwriting). Parallel runs would collide on chunk rows. The baseline suite's single-instance lock already enforces this for the eval step.

---

## 4. Step 0 — precondition checks (do not skip)

These are mechanical facts the bake-off depends on. Verify before Phase 1:

1. **Re-parse replaces chunks (already true as-built).** The as-built embed stage (`worker/stages/embed.py`) already does `DELETE FROM document_chunks WHERE document_id=%s` before re-insert (confirmed in `docs/document-management.md` §10.4: "Re-ingest deletes prior chunks first"). So re-running parse→embed on the same doc is idempotent — no fix needed. *(Self-correction: an earlier draft of this plan listed this as a fix item; the as-built already does it.)*
2. **`reenqueueIngestion` re-runs from parse.** `src/db/queries/documentsAdmin.ts::reenqueueIngestion` inserts an `ingestion_jobs` row at `stage=NULL` (→ `next_stage` returns `"parse"`). `parse.py`'s upsert of `document_texts` overwrites (`ON CONFLICT … DO UPDATE` — already does). So re-ingest → re-parse → re-chunk → re-embed is idempotent given precondition 1. The bulk path uses the Python-native `worker.queue.enqueue` (§6.1), same shape.
3. **No open jobs.** Before each candidate run, confirm `ingestion_jobs` has no `queued`/`running` rows (otherwise a stale job from a prior run contaminates this label).
4. **Scanned-subset fixture.** Identify ~5–10 known-scanned WRI PDFs (near-empty text layer under the current parser / `needs_review` status) for the OCR dimension. Tag them in the fixture manifest (§5).
5. **Baseline label exists.** Run `parse-pypdf` first as the baseline; all comparisons are vs it.
6. **In-flight R3/R4 sequenced (§3 sequencing).** Confirm R3 (chunk-builder reconciliation) is landed or explicitly deferred, and that the Phase-1a per-page-text emission mode (to fix R4) is in scope for the parse-stage branch — *before* kicking off candidate runs.
7. **Sparse keyword stats (capture-rich alignment).** Re-parsing changes chunk text, so `document_chunks.sparse` and the `keyword_vocab`/`keyword_corpus_stats` must be rebuilt after each candidate's re-parse via `scripts/build_sparse_keyword.py` (the worker must be idle while it runs — `docs/document-management.md` §4). The baseline suite does **not** do this automatically; add it to the per-candidate run procedure (§6.2).

---

## 5. Phase 0 — parse-quality fixtures (direct, ~20–30 PDFs)

Direct parse-quality measurement on a stratified fixture, before the full-corpus retrieval run. All four research lanes recommended this; it's the only way to score parsers on *WRI-style* reports (public benchmarks aren't).

### 5.1 Fixture selection

Pick ~20–30 WRI PDFs, stratified:
- 8–10 born-digital, multi-column (executive summary / findings layouts)
- 6–8 table-heavy (data tables, indicator tables)
- 5–10 scanned / image-only (from the `needs_review` queue)
- 2–3 with dense reference lists

Record the manifest at `evaluation/fixtures/parse-bakeoff-manifest.json` (list of `external_id` / `s3_key` / `category` / expected page count). These are a subset of the real corpus, not synthetic.

### 5.2 Direct metrics (per parser, per fixture doc)

| Metric | How | Gate question |
|---|---|---|
| Chars/page | `len(full_text) / page_count` | Scanned subset: does recovery rise above the ~0 baseline? |
| Table recovery | Manual spot-check of 3–5 tables per table-heavy doc; score 0/1/partial | Are data tables usable as chunk text? |
| Multi-column reading order | Manual spot-check; flag column interleaving | Does reading order match human order? |
| Reference-section detection | Does the parser flag/section the "References" block? | Can we strip/tag it to cut retrieval noise? |
| CPU pages/sec (Docling) | wall-clock / total pages on a Fargate-sized task | Is throughput acceptable for full-corpus re-parse? |
| $/page (LlamaParse) | invoice / pages | Is the cloud tier affordable for the hard subset? |

### 5.3 Phase 0 procedure

For each `PARSE_BACKEND` in `pypdf`, `docling`, `llamaparse`:
1. Set `PARSE_BACKEND` (+ `LLAMAINDEX_API_KEY` for llamaparse).
2. Run a one-off script `scripts/parse_fixture.py` that, for each fixture doc, loads the PDF bytes, calls the configured `_parse_pdf`, and writes `{parser, external_id, full_text, page_boundaries, chars, wall_ms}` to `evaluation/results/parse-fixture-<parser>.json`.
3. Score the metrics in §5.2 manually into `evaluation/results/parse-fixture-scores.csv`.

**Phase 0 exit:** a short table of per-parser direct metrics. Decide from this whether Docling is the viable primary; whether its OCR suffices or `ocrmypdf` is needed; whether LlamaParse is worth carrying into Phase 1 on the hard subset. Phase 0 is *advisory* — the binding gate is Phase 1 (§7).

---

## 6. Phase 1 — retrieval bake-off (full corpus, eval-gated)

### 6.1 Prep (code changes — implement once, behind the flag)

1. **Add the flag.** In `search-service/app/config.py`, add (mirroring `retrieval_backend`/`keyword_backend`):
   ```python
   # PDF parse backend: "pypdf" (current LlamaIndex PDFReader) | "docling" | "llamaparse"
   parse_backend: str = "pypdf"
   ```
   Add `LLAMAINDEX_API_KEY: str = ""` (already-adjacent env pattern). This realizes the design's `ParserProvider` intent (§11) at the config level; a fuller interface refactor (`parse(pdf) → {structure, chunks, tables, figures}`) is Phase-1b work, not required for the bake-off.
2. **Branch `_parse_pdf`.** In `worker/stages/parse.py`, dispatch on `settings.parse_backend`. **Support two emission modes** (the per-page mode fixes in-flight R4, §3):
   - `pypdf` → current `PDFReader` path (unchanged; `\n\n`-joined `full_text` + boundaries).
   - `docling` → `from llama_index.readers.docling import DoclingReader`; **emit per-page text** (`[(page_no, page_text), ...]`) and derive `full_text = '\n\n'.join(page_texts)` + `page_boundaries` from the parser's own page labels (so the embed stage's `get_page_number_for_position` uses *parser* page numbers, not length-shifted originals — fixes R4). Set `DOCLING_DEVICE=cpu`. Phase 1b: additionally return structured elements (tables/figures/section_path).
   - `llamaparse` → `from llama_parse import LlamaParse`; same per-page + (1b) structured shape from its markdown + page metadata.
   Keep the existing upsert into `document_texts` identical. **Do not** change the chunker in Phase 1a (§3.1). Ownership: Python side owns `document_texts` + `document_chunks` (raw psycopg SQL; no entity maps), per `CLAUDE.md` and `docs/document-management.md` §3.
3. **Bulk re-ingest.** Add `scripts/reingest_all.py` that loops over every non-withdrawn document and calls `worker.queue.enqueue(conn, doc_id)` — the Python-native equivalent of `reenqueueIngestion` (insert `ingestion_jobs` row at `stage=NULL`, `ON CONFLICT … DO NOTHING`). This is the re-parse trigger — **not** `POST /reindex`, which in `postgres` mode only reloads existing chunks (`load_from_postgres`) and does **not** re-parse.
4. **Tests.** Extend `search-service/tests/test_worker_stages.py`:
   - parse tests for `parse_backend=docling` and `=llamaparse` returning the same `(full_text, page_boundaries)` contract shape (use the existing `sample.pdf` fixture).
   - a test that re-ingest of an already-parsed doc overwrites `document_texts` and replaces `document_chunks` (guards precondition 1).
   - **a per-page-text test on a multi-page Chinese fixture asserting page labels match the parser's page metadata** (guards the R4 fix).
   - keep the `pypdf` path tests green (regression guard).
5. **Capture-rich alignment (design §6 #4).** When the parse stage runs under a new backend, persist the parser's structured output alongside `document_texts` so future re-chunk/re-embed can replay without re-parsing. Minimal form: add a nullable `parse_artifacts` jsonb to `document_texts` (or a side table) holding the parser's per-page text + structured elements + parser model version. This is a small migration; sequence it so it doesn't block the bake-off (Phase 1a can run without it), but it is the prerequisite for the design's cheap-swap-future.

### 6.2 Per-candidate run procedure

Run each candidate **sequentially**. For each label in `parse-pypdf`, `parse-docling`, `parse-ocrmypdf-pypdf` (scanned subset only — see §6.3), `parse-llamaparse`:

```bash
# 1. Configure the worker for this backend (export in the worker's env)
export PARSE_BACKEND=docling        # or pypdf / llamaparse
# (LlamaParse only) export LLAMAINDEX_API_KEY=...

# 2. Re-parse the corpus: re-enqueue all docs at the parse stage, then drain
cd search-service
./venv/bin/python scripts/reingest_all.py
T0=$(date +%s); ./venv/bin/python -m worker.main; T1=$(date +%s)
# record re-parse wall-clock: echo $((T1-T0)) > ../evaluation/results/reparse-seconds-parse-docling.txt

# 3. Rebuild sparse keyword stats (capture-rich alignment, §4 precondition 7).
#    Re-parsing changed chunk text, so sparse vectors + vocab must be rebuilt.
#    Worker MUST be idle while this runs (docs/document-management.md §4).
DATABASE_URL="..." ./venv/bin/python -m scripts.build_sparse_keyword

# 4. Retrieval eval under this label (boots search-service in postgres mode,
#    runs cite + answer-retrieval + non-English smoke + /reindex timing)
cd ..
bash evaluation/run-baseline-suite.sh --daemon parse-docling
# progress: tail -f evaluation/results/baseline-suite-parse-docling.log
```

Repeat per candidate. Each run stamps its reports with `EVAL_LABEL=parse-<label>`.

### 6.3 OCR dimension (scanned subset only)

Run `parse-ocrmypdf-pypdf` as a **targeted** run, not a full-corpus run, unless Phase 0 shows Docling's OCR is clearly insufficient:
- Pre-process the scanned fixture/corpus subset with `ocrmypdf --skip-text --deskew --rotate-pages -l eng` into a side directory, point `DOCUMENTS_LOCAL_DIR` at it, keep `PARSE_BACKEND=pypdf`, re-ingest just those docs, and run the baseline suite under label `parse-ocrmypdf-pypdf`.
- Container needs `tesseract-ocr` + `tesseract-ocr-eng` + `ghostscript`; add to the worker image only for this run.

### 6.4 Comparison

Collect the latest report per label:
```bash
ls -lt evaluation/results/eval-report-*.json | head -1   # per label — open and compare
ls -lt evaluation/results/answer-retrieval-*.json | head -1
```
Build a comparison table: per label, cite {precision, recall, F1, passed}, answer-retrieval {chunk P/R/F1, doc P/R/F1}, non-English smoke pass, `/reindex` seconds, re-parse seconds, $/corpus (LlamaParse). Write it to `evaluation/results/parse-bakeoff-comparison-<date>.md`.

---

## 7. Pass criteria (the gate)

A parser is a **viable replacement** for `pypdf` only if **all** hold:

1. **Cite recall** ≥ baseline −2pp (mirror the Phase 0 parity gate; `docs/plans/2026-06-09-phase0-store-and-migration-plan.md` Task 10 used ±2pp / top-20 overlap 0.95).
2. **Answer-retrieval** chunk- and doc-level P/R/F1 within ±2pp of baseline.
3. **No regression** in non-English smoke (rerank=false).
4. **Scanned subset**: char-recovery improves over baseline (or `needs_review` count drops) — otherwise the OCR dimension is required.
5. **Throughput/cost**: Docling CPU pages/sec acceptable for a full-corpus re-parse on Fargate; LlamaParse $/corpus within budget.
6. **License clear** for self-host (Docling MIT ✅; LlamaParse proprietary → egress/legal review).

A parser that fails the gate is not adopted. A parser that passes is the new default; the cloud tier may be retained as a routed escalation for the hard subset only.

---

## 8. Decision tree (post-bake-off)

```
Docling passes the retrieval gate (§7) + throughput ok?
├─ YES → Docling is the new default parse backend.
│        └─ Scanned subset recovered by Docling's OCR?
│           ├─ YES → done.
│           └─ NO  → add ocrmypdf pre-process for the scanned subset (route by text-layer coverage).
└─ NO  → Does Docling fail only on the hard table-heavy subset?
   ├─ YES → route by document class: Docling for easy born-digital, LlamaParse for hard subset.
   └─ NO  → LlamaParse as the default (cloud); accept cost + egress; or revisit MinerU on GPU batch.
```

GROBID (references sidecar) is a **separate, later** decision, gated on whether reference-section noise materially hurts `eval:cite` — not part of this bake-off's gate.

---

## 9. Risks & open questions

- **Chunker confound.** If we also switch to Docling's `HybridChunker` or structure-aware chunking during the bake-off, a retrieval regression could be the chunker, not the parser. Mitigation: Phase 1a keeps the 400/80 chunker constant; structure-aware chunking is a *separate* Phase-1b experiment on the winning parser (§3.1), eval-gated independently.
- **In-flight R3 confound.** The worker's chunk builder already diverges from the Phase-0 migration builder in metadata fields a parser swap touches (§3 sequencing). If R3 is not reconciled first, the bake-off measures parse quality plus pre-existing metadata drift. **Sequence behind R3** (or consciously defer and note it in the comparison).
- **In-flight R4 — fixable, not inheritable.** Per-page-text emission (§6.1) structurally fixes Chinese page-boundary misattribution; the `\n\n`-join-only emission inherits it. The per-page test (§6.1) guards this.
- **Capture-rich vs re-parse cost.** The design's capture-rich principle (§6 #4) wants parser output persisted so future swaps replay only their stage. The bake-off re-parses per candidate (necessary to measure), but production should persist parser artifacts (§6.1 precondition 5) so the *next* swap is cheap. Without that, every future parser change is a full re-parse.
- **Re-parse cost.** Full-corpus re-parse under Docling on CPU Fargate may be slow. Measure in Phase 0 (§5.2) and bound with a per-doc timeout in the worker. If unacceptable, LlamaParse (cloud) or a GPU batch sidecar for Docling/MinerU becomes the path.
- **LlamaParse egress/retention.** Retention period is not publicly disclosed. Confirm in an enterprise agreement before routing any pre-publication WRI drafts through it. Published reports are low-risk.
- **Textract default retention.** Not in the matrix, but if ever considered: enable the AWS Organizations AI services opt-out policy.
- **Fixture representativeness.** 20–30 PDFs may miss failure modes. The full-corpus Phase 1 run is the safety net; Phase 0 is advisory.
- **`document_chunks` ownership.** Per `CLAUDE.md` and `docs/document-management.md` §3, the Python side owns `document_chunks` + `document_texts` rows (raw psycopg SQL; no entity map). New parse backends must continue to write through the existing embed-stage raw-SQL path — no schema change in Phase 1a; Phase 1b populates already-existing columns.
- **Golden-set chunk references.** Phase 1b (structure-aware chunking) changes chunk boundaries and IDs, which can invalidate `answer-golden-dataset.json` chunk references. If Phase 1b proceeds, regenerate the golden set via the chunk-first pipeline (`eval:golden-retrieve`/`-label`/`-assemble`) — noted in `evaluation/README.md`.

---

## 10. Out of scope

- Retrieval tuning (RRF weights, rerankers, thresholds/tiers) — separate workstream.
- Answer synthesis — separate workstream.
- **Phase 1b structure-aware chunking / `HybridChunker` comparison** — a separate chunking experiment on the *winning* parser after selection (§3.1), eval-gated independently, with golden-set regeneration.
- **GROBID** — separate decision. Note the design §7.5 gives GROBID a **metadata-extraction** role (title/authors/DOI/abstract/sections → metadata store + dedup identity key), broader than the "references only" framing in the research brief. Either role is a later, citation/metadata-gated decision, not part of this bake-off's gate.
- MinerU on GPU — only if Docling fails and GPU batch is acceptable.

---

## 11. Deliverables

- `evaluation/fixtures/parse-bakeoff-manifest.json` — fixture manifest
- `evaluation/results/parse-fixture-<parser>.json` + `parse-fixture-scores.csv` — Phase 0 direct metrics
- `evaluation/results/baseline-suite-parse-<label>.log` + `eval-report-*.json` + `answer-retrieval-*.json` — Phase 1 retrieval results per candidate
- `evaluation/results/parse-bakeoff-comparison-<date>.md` — the decision table
- `scripts/reingest_all.py` — bulk re-ingest (committed; reusable beyond the bake-off)
- `scripts/parse_fixture.py` — Phase 0 fixture runner (committed)
- Code: `parse_backend` flag in `config.py`, branched `_parse_pdf` in `parse.py`, extended tests

---

## 12. Execution order (summary)

1. **Sequence behind in-flight R3/R4** (`docs/plans/2026-07-02-next-steps-qa-deploy.md` Part 2): reconcile the chunk builder (R3) or confirm it's deferred; scope the per-page-text emission mode for R4.
2. Step 0 precondition checks (§4) — note the embed stage already deletes-then-reinserts chunks (no fix needed); plan the sparse-stats rebuild into the per-candidate procedure.
3. Phase 0 prep: fixture manifest + `scripts/parse_fixture.py`; add the `parse_backend` flag + branched `_parse_pdf` (with per-page emission) + tests (§6.1).
4. Phase 0 runs: `pypdf` → `docling` → `llamaparse` on the fixture; score direct metrics (§5).
5. Phase 0 exit: decide primary candidate + whether OCR dimension is needed.
6. Phase 1a: `scripts/reingest_all.py`; sequential full-corpus runs `parse-pypdf` (baseline) → `parse-docling` → (`parse-ocrmypdf-pypdf` if needed) → (`parse-llamaparse` if needed); **sparse-stats rebuild + baseline suite per label** (§6.2).
7. Comparison table + decision tree (§8) → recommendation to the team.
8. **Only after a parser passes the §7 gate**: Phase 1b structure-aware chunking on the winning parser as a *separate* eval-gated experiment (§3.1), with golden-set regeneration.
