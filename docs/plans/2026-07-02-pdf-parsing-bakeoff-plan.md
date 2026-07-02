# PDF Parsing Bake-off — Plan

**Date:** 2026-07-02
**Status:** Ready to execute
**Workstream:** Retrieval / Document Management — parse stage only
**Brief:** `docs/research/2026-07-02-pdf-parsing-bakeoff-brief.md`
**Prior art:** `docs/research/2026-06-10-sparse-model-bakeoff-brief.md` (same shape: backend swap, eval-gated, no cutover until metrics pass)

---

## 1. Goal

Decide, **eval-gated**, whether the ingestion worker's parse stage (`search-service/worker/stages/parse.py`) should replace LlamaIndex `PDFReader` (pypdf text-layer extraction) with a layout-aware parser, and if so which one(s) and under what routing. **No production cutover until retrieval metrics pass the gate in §7.**

This is the parse-stage analogue of the sparse-retrieval bake-off. It reuses the repo's proven harness: `evaluation/run-baseline-suite.sh --daemon <label>` with `EVAL_LABEL`-stamped reports.

---

## 2. Candidates & matrix

The parse stage has two independent dimensions. The bake-off varies **one dimension at a time** (§3).

**Dimension 1 — base parser** (the `_parse_pdf` branch):
| Label | `PARSE_BACKEND` | Library | Notes |
|---|---|---|---|
| `parse-pypdf` | `pypdf` | LlamaIndex `PDFReader` (current) | Baseline — no change |
| `parse-docling` | `docling` | `DoclingReader` (MIT, CPU) | Primary candidate; layout + tables + its own OCR |
| `parse-llamaparse` | `llamaparse` | `LlamaParse` (cloud) | Escalation; cost + egress; needs `LLAMAINDEX_API_KEY` |

**Dimension 2 — OCR pre-process** (only for the scanned subset, tested if Docling's OCR is insufficient):
| Label | Pre-process | Then |
|---|---|---|
| `parse-ocrmypdf-pypdf` | `ocrmypdf --skip-text --deskew --rotate-pages -l eng` | unchanged `pypdf` path |

**Not in the matrix** (ruled out in the brief): Marker (GPL), PyMuPDF4LLM (AGPL), Nougat (CC-BY-NC), MinerU (GPU-VLM; consider only if Docling fails and GPU batch is acceptable), GROBID (references-only sidecar; separate decision, §9).

---

## 3. Experimental design

**One variable at a time.** Phase 1 retrieval runs keep the **chunker constant** (existing 400-char/80-overlap) and feed it each parser's `full_text`, so the only variable is parse quality. A *later* follow-up can test Docling's `HybridChunker` vs the 400/80 chunker; that is a chunker experiment, not a parser experiment, and stays out of this bake-off.

**The `/query` contract is untouched.** The parse stage's output contract is `(full_text, page_boundaries)` written to `document_texts` (upsert). Each backend must produce that same shape (Docling/LlamaParse markdown → `full_text`; derive `page_boundaries` from their page metadata). No `QueryRequest`/`QueryResponse` change.

**Runs are sequential, not parallel.** Each candidate re-parses the same corpus into the same Postgres `document_chunks` table (overwriting). Parallel runs would collide on chunk rows. The baseline suite's single-instance lock already enforces this for the eval step.

---

## 4. Step 0 — precondition checks (do not skip)

These are mechanical facts the bake-off depends on. Verify before Phase 1:

1. **Re-parse replaces chunks, not appends.** Read `search-service/worker/stages/embed.py` and confirm it deletes the document's existing `document_chunks` before re-inserting. If it does not, re-running parse→embed on the same doc will duplicate chunks and corrupt retrieval eval. Fix (add `DELETE FROM document_chunks WHERE document_id = %s` at the top of the embed stage) before the bake-off.
2. **`reenqueueIngestion` re-runs from parse.** `src/db/queries/documentsAdmin.ts::reenqueueIngestion` inserts an `ingestion_jobs` row at `stage=NULL` (→ `next_stage` returns `"parse"`). Confirm `parse.py`'s upsert of `document_texts` overwrites (`ON CONFLICT … DO UPDATE` — already does). So re-ingest → re-parse → re-chunk → re-embed is idempotent *given* precondition 1.
3. **No open jobs.** Before each candidate run, confirm `ingestion_jobs` has no `queued`/`running` rows (otherwise a stale job from a prior run contaminates this label).
4. **Scanned-subset fixture.** Identify ~5–10 known-scanned WRI PDFs (near-empty text layer under the current parser / `needs_review` status) for the OCR dimension. Tag them in the fixture manifest (§5).
5. **Baseline label exists.** Run `parse-pypdf` first as the baseline; all comparisons are vs it.

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
   Add `LLAMAINDEX_API_KEY: str = ""` (already-adjacent env pattern).
2. **Branch `_parse_pdf`.** In `worker/stages/parse.py`, dispatch on `settings.parse_backend`:
   - `pypdf` → current `PDFReader` path (unchanged).
   - `docling` → `from llama_index.readers.docling import DoclingReader`; produce `(full_text, page_boundaries)` from the `DoclingDocument` (markdown → `full_text`; page metadata → boundaries). Set `DOCLING_DEVICE=cpu`.
   - `llamaparse` → `from llama_parse import LlamaParse`; produce the same `(full_text, page_boundaries)` shape from its markdown + page metadata.
   Keep the existing upsert into `document_texts` identical. **Do not** change the chunker or any downstream stage.
3. **Bulk re-ingest.** Add `scripts/reingest_all.py` (or an admin route `POST /api/admin/documents/reingest-all`) that loops over every non-withdrawn document and calls `worker.queue.enqueue(conn, doc_id)` — the Python-native equivalent of `reenqueueIngestion` (insert `ingestion_jobs` row at `stage=NULL`, `ON CONFLICT … DO NOTHING`). This is the re-parse trigger — **not** `POST /reindex`, which in `postgres` mode only reloads existing chunks (`load_from_postgres`) and does **not** re-parse.
4. **Tests.** Extend `search-service/tests/test_worker_stages.py`:
   - parse tests for `parse_backend=docling` and `=llamaparse` returning the same `(full_text, page_boundaries)` contract shape (use the existing `sample.pdf` fixture).
   - a test that re-ingest of an already-parsed doc overwrites `document_texts` and replaces `document_chunks` (guards precondition 1).
   - keep the `pypdf` path tests green (regression guard).

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

# 3. Retrieval eval under this label (boots search-service in postgres mode,
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

- **Chunker confound.** If we also switch to Docling's `HybridChunker` during the bake-off, a retrieval regression could be the chunker, not the parser. Mitigation: keep the 400/80 chunker constant in Phase 1 (§3). Test chunkers separately afterward.
- **Re-parse cost.** Full-corpus re-parse under Docling on CPU Fargate may be slow. Measure in Phase 0 (§5.2) and bound with a per-doc timeout in the worker. If unacceptable, LlamaParse (cloud) or a GPU batch sidecar for Docling/MinerU becomes the path.
- **LlamaParse egress/retention.** Retention period is not publicly disclosed. Confirm in an enterprise agreement before routing any pre-publication WRI drafts through it. Published reports are low-risk.
- **Textract default retention.** Not in the matrix, but if ever considered: enable the AWS Organizations AI services opt-out policy.
- **Fixture representativeness.** 20–30 PDFs may miss failure modes. The full-corpus Phase 1 run is the safety net; Phase 0 is advisory.
- **`document_chunks` ownership.** Per `CLAUDE.md`, the Python side owns `document_chunks` rows (raw SQL). The new parse backends must continue to write through the existing embed stage's raw-SQL path — no entity mapping, no schema change.

---

## 10. Out of scope

- Retrieval tuning (RRF weights, rerankers, thresholds/tiers) — separate workstream.
- Answer synthesis — separate workstream.
- Chunker comparison (Docling `HybridChunker` vs 400/80) — follow-up after the parser decision.
- GROBID references sidecar — separate, citation-semantics-gated decision.
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

1. Step 0 precondition checks (§4) — fix embed-stage chunk replacement if needed.
2. Phase 0 prep: fixture manifest + `scripts/parse_fixture.py`; add the `parse_backend` flag + branched `_parse_pdf` + tests (§6.1).
3. Phase 0 runs: `pypdf` → `docling` → `llamaparse` on the fixture; score direct metrics (§5).
4. Phase 0 exit: decide primary candidate + whether OCR dimension is needed.
5. Phase 1: `scripts/reingest_all.py`; sequential full-corpus runs `parse-pypdf` (baseline) → `parse-docling` → (`parse-ocrmypdf-pypdf` if needed) → (`parse-llamaparse` if needed); baseline suite per label (§6.2).
6. Comparison table + decision tree (§8) → recommendation to the team.
