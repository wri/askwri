# PDF Parsing Bake-off — Research Brief

**Date:** 2026-07-02
**Status:** Open — decision gated on the bake-off (see `docs/plans/2026-07-02-pdf-parsing-bakeoff-plan.md`)
**Workstream:** Retrieval / Document Management — *parse stage only* (not answer synthesis, not retrieval tuning)
**Depends on:** `docs/document-management.md` (as-built parse stage); `search-service/worker/stages/parse.py` (current `PDFReader`/pypdf path)

---

## 1. Decision to Make

**Should the ingestion worker's PDF parse stage replace LlamaIndex `PDFReader` (pypdf text-layer extraction) with a layout-aware parser — and if so, which one(s), under what routing?**

Today, `search-service/worker/stages/parse.py::_parse_pdf` writes PDF bytes to a temp file and calls `PDFReader().load_data(...)`, then joins per-page text with `\n\n` and records page boundaries. This is **text-layer-only**: no layout, no tables, no OCR, no section structure. Scanned/image-only PDFs yield empty text and fall through to `needs_review`. The output feeds a 400-char/80-overlap chunker → embeddings → Postgres+pgvector → hybrid BM25+dense retrieval.

The corpus is World Resources Institute (WRI) research outputs — working papers, technical reports, data briefs. Mix of born-digital and older scanned reports. Often **multi-column**, with **data tables**, charts, footnotes, and references. Policy/scientific research style, not arXiv math papers.

This is the parse-stage analogue of the sparse-retrieval bake-off (`docs/research/2026-06-10-sparse-model-bakeoff-brief.md`): a backend swap, **eval-gated**, no production cutover until retrieval metrics pass.

---

## 2. Why It Matters

Independent 2026 benchmarking (**PDFbench**, Applied AI, 800+ docs across 17 parsers) finds that **academic/research-style reports are the hardest document class for every parser** — even frontier LLMs cap at ~60% edit similarity on that subset, and the leading dedicated parser drops to ~38%. WRI's densest multi-column data tables will not be cleanly recovered by any single tool. Implications:

- **Multi-column reading order** is scrambled by pypdf → chunks interleave columns → retrieval noise.
- **Tables** are flattened to incoherent text → neither chunking nor retrieval can surface them cleanly.
- **Section boundaries** are absent → 400/80 chunks split mid-section and lose heading context.
- **Reference lists** are embedded as content → retrieval noise (a general layout parser can *detect* a references section; only GROBID parses references into fields).
- **Scanned reports** produce nothing → `needs_review` queue.

Fixing the parse stage is the highest-leverage upstream improvement available; retrieval tuning and answer synthesis are explicitly **out of scope** here (per `CLAUDE.md`), and downstream changes can't recover what the parser destroyed.

---

## 3. Candidates (consensus across 4 research lanes)

Four parallel `researcher` subagents covered: (A) local layout parsers, (B) cloud/commercial APIs, (C) scholarly structure extractors, (D) OCR for scanned PDFs. Full lane briefs live alongside this file:

- `docs/research/2026-07-02-pdf-parsing-local-layout-parsers.md`
- `docs/research/2026-07-02-pdf-parsing-cloud-commercial-apis.md`
- `docs/research/2026-07-02-pdf-parsing-paper-structure-extractors.md`
- `docs/research/2026-07-02-pdf-parsing-ocr-for-scanned.md`

### 3.1 Recommended architecture (tiered, route by document class)

| Lane | Top pick | Role | License | Cost | CPU/Fargate |
|---|---|---|---|---|---|
| **Local base parser** | **Docling** (IBM/LF AI & Data) | Replace `PDFReader`; layout + tables + reading order + its own OCR; native `DoclingReader` + structure-aware chunkers | **MIT** (code) | Free | ✅ `DOCLING_DEVICE=cpu` |
| **Cloud escalation** | **LlamaParse** (LlamaIndex) | Hard subset only (table-heavy/scanned where Docling underperforms); same ecosystem as current `PDFReader` | proprietary | ~$0.003/pg; 1k pg/mo free | n/a (cloud) |
| **OCR pre-process** | **ocrmypdf** (Tesseract) | If Docling's OCR is weak on the scanned subset: pre-process → searchable PDF → unchanged parse path | **MPL-2.0** + Apache-2.0 (Tesseract) | Free | ✅ CPU-native |
| **References (optional)** | **GROBID** sidecar (CRF) | Only if citation-aware retrieval / reference-stripping-by-structure becomes a goal | **Apache-2.0** | Free | ✅ CRF backend (JVM sidecar) |

### 3.2 License is the real differentiator among local tools

| Tool | License | Self-host in this service? |
|---|---|---|
| **Docling** | MIT (code); model licenses vary | ✅ clear |
| **MinerU** (pipeline) | Apache-2.0-based + extra conditions | ⚠️ legal review |
| **Unstructured** | Apache-2.0 | ✅ clear (but OSS maintenance has slowed) |
| **Marker** | GPL-3.0 + OpenRAIL-M weights | ❌ paid commercial license for self-host |
| **PyMuPDF4LLM** | AGPL-3.0 | ❌ blocker for this service |
| **Nougat** | CC-BY-NC weights | ❌ non-commercial |

### 3.3 Skip list (with reason)

- **Marker** — excellent output but GPL + OpenRAIL-M → paid license for self-host.
- **PyMuPDF4LLM** — fast/light but AGPL-3.0 → blocker.
- **Nougat** — arXiv-math niche, CC-BY-NC, weak tables, GPU-oriented.
- **ScienceParse, S2ORC/doc2json, CERMINE, Crossref pdfextract** — abandoned / dormant / retired.
- **EasyOCR** — no built-in layout/reading-order; lightly maintained.
- **A dedicated scholarly parser *for chunking*** — Docling already yields section boundaries; GROBID only earns its keep for reference semantics, not chunking.
- **MinerU as default** — highest independent accuracy (OmniDocBench 86.47 vs Marker 78.44) but heaviest ops + no first-party LlamaIndex reader; consider only if Docling accuracy is insufficient and GPU batch is acceptable.

---

## 4. Cloud options — ranked (detail in lane B)

| Rank | API | $/page (2025–26) | Output | Privacy posture |
|---|---|---|---|---|
| #1 | **LlamaParse** | ~$0.003 (1k pg/mo free) | markdown + JSON + tables + cell bbox | egress to LlamaIndex cloud; VPC option enterprise; retention not publicly disclosed |
| #2 | Adobe PDF Extract | 500 free tx/mo; paid contact sales | JSON + markdown + tables + figures + bbox | **best documented**: ≤24h retention, per-transaction US/EU |
| #3 | Azure AI Document Intelligence | $0.01 (Layout) | JSON + markdown (Layout) | prebuilt models don't train on customer data; CMK |
| #4 | Google Cloud Document AI | $0.01 (Layout Parser) | `Document` JSON (markdown derived) | regional; Google won't train on customer data |
| #5 | AWS Textract | $0.015 (tables+layout) | **JSON Blocks only** (write a converter) | ⚠️ may store for service improvement unless opted out |
| #6 | Mathpix | $0.005 | markdown + LaTeX tables/equations | lighter enterprise posture |
| #7 | Mistral OCR | $0.001 (½ in batch) | markdown + multi-column + tables | newest; least battle-tested |

**LlamaParse vs current `PDFReader`:** same LlamaIndex reader interface → minimal glue; adds layout/tables/OCR the current path lacks; tradeoff is cloud dependency + egress review. **AWS Textract** has tenancy affinity with the Fargate stack but returns JSON Blocks (converter needed) and retains content by default — enable the AWS Orgs AI opt-out policy if used.

---

## 5. Scholarly structure — is a dedicated parser worth it? (lane C)

**Split decision.** YES to structure parsing in general; **NO** to *requiring* a dedicated scholarly parser for the chunking goal.

- For multi-column order, section boundaries, and tables (the RAG chunking wins), a **general layout parser (Docling)** captures ~all the value, is lighter to deploy, and has a native LlamaIndex reader + chunkers.
- For **reference semantics** (parse bibliography into author/title/year/DOI + link citation callouts), only **GROBID** does this well (~0.87–0.90 F1). Worth adding **only if** citation-aware retrieval or reference-stripping-by-structure becomes a goal — not for plain chunking.

**Net:** primary investment = Docling as the new base layer. Add GROBID (Docker JVM sidecar, CRF on CPU) as an optional references-only layer when citation semantics are in scope.

---

## 6. OCR for scanned PDFs — strategy (lane D)

**Keep the existing parse path unchanged; add `ocrmypdf` as a CPU pre-process step for the scanned subset.**

1. **Detect text-layer coverage** per doc (sum `len(page.extract_text().strip())` across pages; threshold ~50 chars/page, tunable).
2. Has text layer → existing path. Near-empty → `ocrmypdf --skip-text --deskew --rotate-pages -l eng` → searchable PDF/A.
3. Feed the OCR'd PDF into the **unchanged** parse path — no new chunking, no schema change, no `/query` contract change.
4. Optional GPU escalation lane (Surya 2 / PaddleOCR-VL) for the residual hard cases — **not** on Fargate CPU; separate workstream.

`--skip-text` is the key flag for WRI's **mixed** PDFs: OCRs only image-only pages, leaves digital-text pages untouched. Avoid `--force-ocr` by default (rasterizes good text pages). Container image needs `tesseract-ocr` + a language pack + `ghostscript`.

---

## 7. Open questions the bake-off must resolve

All four lanes independently flagged the same gap: **no benchmark exists on WRI-style policy reports** (everything cited is arXiv/PMC/business docs). The bake-off plan (`docs/plans/2026-07-02-pdf-parsing-bakeoff-plan.md`) resolves these on *our* corpus:

1. Does Docling pass the retrieval gate (cite recall ≥ baseline −2pp; answer-retrieval P/R/F1 within ±2pp)?
2. Is Docling's OCR sufficient for the scanned subset, or is `ocrmypdf` pre-process needed?
3. Is Docling CPU throughput acceptable on Fargate (pages/sec)?
4. For the hardest table-heavy subset, is LlamaParse worth ~$0.003/pg + egress?
5. Does GROBID's reference parsing materially improve `eval:cite` (warranting a JVM sidecar)?

---

## 8. Confidence

- **High:** tool capabilities, licenses, CPU/cloud feasibility, LlamaIndex-readiness, and pricing for the named tools (each verified against primary sources in the lane briefs).
- **Medium:** relative accuracy ranking on *WRI-style* reports (public benchmarks don't cover this corpus; the bake-off closes this).
- **Medium:** LlamaParse exact USD/page (credit model; $0.003 is PDFbench-derived) and Adobe paid $/page (contact-sales).

---

*Synthesis of four web-sourced `researcher` subagent briefs committed alongside this file. See the four lane briefs for per-tool evidence, GitHub/pricing links, and the independent PDFbench / OmniDocBench benchmark citations.*
