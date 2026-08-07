# Research: Local, Open-Source PDF Layout Parsers (self-hosted, no cloud APIs)

**Scope:** the PDF → markdown/JSON/structure parsing stage only. Target stack: Python 3.12, FastAPI + LlamaIndex worker on AWS ECS **Fargate (CPU-only)**, RDS Postgres+pgvector. Corpus: WRI policy/scientific reports — multi-column, data tables, charts/figures, footnotes/references; mix of born-digital + older scanned. Not arXiv math papers. Date of research: 2026-07-02.

## Summary

For a CPU-only Fargate Python/LlamaIndex ingestion worker handling WRI's multi-column reports with tables, **Docling (IBM/LF AI & Data) is the top pick**: MIT-licensed, natively integrated with LlamaIndex, runs on CPU, recovers reading order/table structure, emits lossless JSON + markdown + chunks, and is very actively maintained. If maximum independent-benchmark accuracy is worth heavier ops, **MinerU pipeline mode** is the strongest open-source pipeline (OmniDocBench Overall 86.47 vs Marker 78.44) and is Apache-2.0-based. **Marker** and **PyMuPDF4LLM** are strong but carry copyleft/commercial-license caveats (GPL-3.0 + OpenRAIL-M; AGPL-3.0 respectively) that need legal sign-off before self-hosting in a public service. **Nougat** is not a fit (academic-math niche, non-commercial weights, weak tables).

## Ranked recommendation (local, CPU-feasible, scientific reports w/ tables)

| # | Tool | License | CPU on Fargate | LlamaIndex | Layout/tables | Best-for / caveat |
|---|------|--------|----------------|-----------|---------------|--------------------|
| 1 | **Docling** | MIT (code); model licenses vary | ✅ `DOCLING_DEVICE=cpu` | ✅ native `DoclingReader` (also LangChain/CrewAI/Haystack) | RT-DETR layout + TableFormer tables; reading order; charts→tables | Best license+integration+all-rounder. Some multi-column edge cases. |
| 2 | **MinerU (pipeline mode)** | "MinerU OSS License" (Apache-2.0-based) | ✅ pipeline mode runs CPU; 1.2B VLM mode needs GPU | ⚠️ wrap manually (no first-party reader) | DocLayout-YOLO + PaddleOCR + table rec; strongest open-source pipeline accuracy | Heaviest ML footprint/ops. Chinese-origin emphasis. |
| 3 | **Marker** | GPL-3.0 code + OpenRAIL-M weights (commercial self-host needs paid license) | ⚠️ runs CPU/MPS but Surya models are slow on CPU; wants GPU | ✅ `PDFMarkerReader` (`llama-index-readers-pdf-marker`) | Surya layout/OCR/reading-order; good tables+math | Strong out-of-box markdown; license + CPU throughput are the catches. |
| 4 | **PyMuPDF4LLM** | AGPL-3.0 + Artifex commercial license | ✅ no GPU, MuPDF C engine, very fast | ✅ built-in `LlamaMarkdownReader` + `PyMuPDFReader` | Heuristic multi-column + rule-based tables | Fastest/lightest; **AGPL is a blocker** for proprietary use; weaker on complex tables/columns than ML parsers. |
| 5 | **Unstructured** | Apache-2.0 | ✅ `MODEL.DEVICE='cpu'` (detectron2_onnx/yolox) | ✅ `UnstructuredReader` | hi_res layout; tables as HTML in `metadata.text_as_html` | OSS maintenance has slowed (vendor pivoted to paid API); detectron2/ONNX install is fiddly. |
| — | **Nougat** | MIT code; **CC-BY-NC weights** | ⚠️ CPU works but slow + unreliable failure detection | ❌ no first-party reader | Academic math/LaTeX (`.mmd`); **weak tables** | Not recommended for WRI reports. |

## Per-tool detail

### 1. Docling — `docling-project/docling` (recommended)
- **What:** Document-conversion toolkit; advanced PDF understanding (page layout, reading order, table structure, code, formulas, image classification). Unified `DoclingDocument` model. Started by IBM Research Zurich; now an **LF AI & Data Foundation** project.
- **License:** MIT codebase; `docling-parse` MIT; `docling-ibm-models` (RT-DETR layout + TableFormer) — per-model licenses; GraniteDocling VLM is Apache-2.0.
- **Deps/runtime:** `pip install docling`; Python ≥3.10. Models download on first run. CPU + GPU (`cuda`/`mps`); `DOCLING_DEVICE=cpu`, `DOCLING_NUM_THREADS`. Fargate-compatible (no GPU).
- **Output:** Markdown, HTML, **lossless JSON**, DocTags, plus tables → DataFrame/markdown/CSV/HTML; built-in chunkers; `docling-serve` API server + CLI.
- **Tables/columns/headings:** TableFormer gives structured tables → markdown tables; reading-order reconstruction for multi-column; heading hierarchy. Known multi-column edge cases exist (issue #2067).
- **LlamaIndex:** Native first-party integration (`DoclingReader`).
- **Maturity:** Very active (v2.70+, Discord, OpenSSF best practices, CVPR/arXiv tech report 2408.09869). Chart understanding added recently.
- **Fit:** Best overall for WRI — MIT avoids the copyleft/commercial-license problem that affects Marker/PyMuPDF4LLM, it's CPU-runnable on Fargate, OCR covers the scanned subset, and it drops straight into the existing LlamaIndex worker. Primary source: https://github.com/docling-project/docling

### 2. MinerU (pipeline mode) — `opendatalab/MinerU`
- **What:** OpenDataLab PDF/document parser; pipeline = DocLayout-YOLO (layout) + PaddleOCR (OCR) + table recognition; optional VLM mode (`MinerU2.5-Pro-2605`, 1.2B).
- **License:** "MinerU Open Source License" — Apache-2.0-based with extra conditions (officially moved off AGPLv3).
- **Deps/runtime:** Python; deps include PaddleOCR, pypdfium2, pdftext, modelscope; VLM mode needs GPU. **Pipeline mode runs CPU**; also CUDA/NPU/MPS.
- **Output:** Markdown/JSON; tables typically rendered as HTML-in-markdown.
- **Quality:** On the independent **OmniDocBench v1.6** end-to-end leaderboard, **MinerU-Pipeline Overall = 86.47** (Table TEDS 81.88, TEDS-S 88.68) — the top open-source *pipeline* tool, ahead of Marker (78.44). The VLM `MinerU2.5-Pro` tops the whole board at 95.75 (Table TEDS 93.42) but needs GPU.
- **LlamaIndex:** No first-party reader; needs a thin wrapper.
- **Fit:** Highest independent-benchmark accuracy among CPU-feasible open-source pipelines and Apache-style license — but the heaviest ops/maintenance footprint (large models, multi-component stack, strong multilingual/Chinese-document emphasis). Strong #2 if accuracy justifies the complexity. Primary source: https://github.com/opendatalab/MinerU

### 3. Marker — `datalab-to/marker` (formerly `VikParuchuri/marker`)
- **What:** PDF/image/PPTX/DOCX/XLSX/HTML/EPUB → markdown/JSON/chunks/HTML. Uses **Surya** for OCR, layout detection, reading order.
- **License:** **GPL-3.0 code; model weights OpenRAIL-M** (free for research/personal/startups under $2M funding/revenue; **commercial self-hosting requires a paid license** from datalab.to).
- **Deps/runtime:** `pip install marker-pdf`; Python ≥3.10; PyTorch. Works on GPU/CPU/MPS; ~5GB VRAM peak per worker, ~3.5GB avg; ~25 pages/sec batch on H100. First-run model downloads. CPU works but is much slower (Surya models).
- **Output:** markdown/json/html/chunks; images extracted/saved; headers/footers stripped; optional `--use_llm` (Gemini/Ollama) to boost tables/math/forms; `TableConverter` for table-only extraction.
- **Quality:** Vendor benchmark favors Marker over Docling (heuristic 95.67 vs 86.71; LLM 4.24 vs 3.70) — but that's Marker-authored. On **independent OmniDocBench v1.6**, Marker Overall = **78.44** (Table TEDS 65.77) — below MinerU-Pipeline (86.47).
- **LlamaIndex:** `PDFMarkerReader` (`llama-index-readers-pdf-marker`).
- **Fit:** Excellent out-of-box markdown and a ready LlamaIndex reader, but two real catches for WRI: (a) GPL + OpenRAIL-M means a paid commercial license for a public-facing self-hosted service, and (b) on CPU-only Fargate throughput will be limited. Primary source: https://github.com/datalab-to/marker

### 4. PyMuPDF4LLM — `pymupdf/pymupdf4llm`
- **What:** Lightweight extension to PyMuPDF (MuPDF C engine) → markdown/JSON/plain text for RAG. "No GPU, no Cloud, no Tokens."
- **License:** **AGPL-3.0** with an **Artifex commercial license** option. (PyMuPDF, PyMuPDF4LLM, PyMuPDF Pro all share this dual license.) Going through a LlamaIndex reader does **not** remove the AGPL obligation.
- **Deps/runtime:** `pip install pymupdf4llm` (pulls PyMuPDF + PyMuPDF Layout). CPU-only; very fast — third-party bench ~0.091 s/page single-threaded CPU. Hybrid OCR (selective — only OCRs regions that need it; ~50% faster than full OCR) via Tesseract/RapidOCR/PaddleOCR.
- **Output:** markdown, JSON (bbox + layout metadata per element), text, or LlamaIndex docs; GitHub-flavored markdown tables; multi-column reading order; header/footer removal; page chunking with metadata.
- **Quality:** Layout is **heuristic/font-based** and tables are **rule-based** — fast and clean for born-digital PDFs, but weaker than ML parsers (Docling/MinerU/Marker) on complex/nested tables and hard multi-column layouts.
- **LlamaIndex:** Built-in `pymupdf4llm.LlamaMarkdownReader()` and LlamaIndex's `PyMuPDFReader`.
- **Fit:** Fastest, lightest, best for clean born-digital WRI reports — but **AGPL is a blocker for proprietary/closed-source use** unless you buy the Artifex commercial license. Strong optional *fast-path* if that license is acceptable; not the primary parser. Primary source: https://github.com/pymupdf/pymupdf4llm

### 5. Unstructured — `Unstructured-IO/unstructured`
- **What:** ETL library converting documents to structured elements; `partition_pdf(...)` with `strategy="hi_res"` for layout-aware parsing (uses `unstructured-inference`).
- **License:** Apache-2.0.
- **Deps/runtime:** PDF extras (`unstructured-ingest[pdf]`): pdfminer.six, pypdf, Pillow; inference via `unstructured-inference`. Default hi_res model is **`detectron2_onnx`** (ONNX Runtime, fastest) or `yolox`; Detectron2 itself is optional and finicky (not officially supported on Windows). CPU works (`MODEL.DEVICE='cpu'`); GPU optional.
- **Output:** list of typed elements (`Table`, `Title`, `NarrativeText`, …) with `text` + `metadata.text_as_html` (HTML tables). To get tables: `strategy="hi_res"`, `skip_infer_table_types=False`.
- **LlamaIndex:** `UnstructuredReader`.
- **Fit:** Apache-2.0 + native LlamaIndex reader are attractive, but the OSS library's maintenance pace has slowed (the vendor pivoted to a paid Platform API), table output is HTML-in-metadata (less clean than Docling's markdown), and the detectron2/ONNX stack is more fragile on Fargate than Docling. Workable but not the 2026 default. Primary source: https://github.com/Unstructured-IO/unstructured

### Nougat — `facebookresearch/nougat` (not recommended)
- **What:** Meta's visual-transformer OCR for **academic PDF papers** → `.mmd` (Mathpix-Markdown) preserving LaTeX math/tables.
- **License:** MIT code; **model weights CC-BY-NC (non-commercial)** — check before any commercial use.
- **Deps/runtime:** PyTorch; pip from GitHub; GPU-friendly; CPU runs but slow and prone to failure-detection false positives on CPU/older GPUs.
- **Quality:** Math/LaTeX is the strength; **tables are a known weak area**; built for arXiv-style papers, not WRI policy reports.
- **Fit:** Wrong shape for WRI (non-commercial weights + academic-math niche + weak tables). Skip as primary. Primary source: https://github.com/facebookresearch/nougat

### Other 2024–2026 contenders (brief)
- **GROBID** (`kaiar Rek/forks`, `grobidOrg/grobid`) — Java, scholarly/technical PDFs → TEI XML (sections, references, figures, tables). Excellent for academic structure/metadata; Java stack (not Python-native); useful as a *complement* to Docling for references/footnotes.
- **Surya** (`VikParuchuri/surya`) — the OCR/layout/reading-order engine inside Marker; usable standalone if you want Marker's models without Marker's pipeline.
- **PP-StructureV3** (`PaddlePaddle/PaddleOCR`) — modular layout + table-rec + OCR + layout-recovery pipeline; was on OmniDocBench eval; PaddlePaddle deps; a MinerU alternative.
- **GOT-OCR2.0** (`Ucas-HaoranWei/GOT-OCR2.0`) — unified OCR VLM (text/formulas/tables/charts); research-oriented, less of an out-of-box layout pipeline.
- **Camelot** (`camelot-dev/camelot`) — table-only (lattice/stream); good for targeted table backfill, not full layout.
- **LayoutParser** (`Layout-Parser/layout-parser`) — toolkit/DIY, not a turnkey parser.

## Evidence (primary sources + independent benchmark)
- Marker repo (GPL-3.0, OpenRAIL-M, CPU/GPU/MPS, 5GB VRAM/worker, markdown/json/html/chunks, `pip install marker-pdf`, Python 3.10+, hybrid LLM mode, uses Surya): https://github.com/datalab-to/marker — license + commercial-usage text confirmed in README.
- Docling repo (MIT, LF AI & Data, advanced PDF understanding, markdown/HTML/lossless JSON/DocTags/chunks, CLI + `docling-serve`, native LlamaIndex/LangChain/CrewAI/Haystack, Python ≥3.10, CPU+GPU, GraniteDocling VLM): https://github.com/docling-project/docling — license + features confirmed in README.
- PyMuPDF4LLM repo (**AGPL-3.0**, no-GPU, markdown/JSON/text/LlamaIndex docs, hybrid selective OCR, multi-column + GitHub-markdown tables, `LlamaMarkdownReader`, requires PyMuPDF/PyMuPDF Layout): https://github.com/pymupdf/pymupdf4llm — AGPL license badge + features confirmed in README.
- Unstructured repo (Apache-2.0, `partition_pdf`, hi_res, `unstructured-inference`, tables in `metadata.text_as_html`): https://github.com/Unstructured-IO/unstructured ; inference/models: https://github.com/Unstructured-IO/unstructured-inference ; table example: https://docs.unstructured.io/examplecode/codesamples/apioss/table-extraction-from-pdf
- Nougat repo (MIT code, academic-paper OCR, `.mmd`/LaTeX, CPU/GPU notes): https://github.com/facebookresearch/nougat ; paper: https://arxiv.org/abs/2308.13418
- MinerU repo ("MinerU OSS License" Apache-2.0-based, CPU/GPU/NPU/MPS, PaddleOCR + DocLayout-YOLO + 1.2B VLM): https://github.com/opendatalab/MinerU
- **OmniDocBench** (independent CVPR-2025 benchmark, v1.6_full end-to-end leaderboard): https://github.com/opendatalab/OmniDocBench — verified numbers: **MinerU-Pipeline 86.47** (Table TEDS 81.88), **Marker 78.44** (Table TEDS 65.77); VLM `MinerU2.5-Pro` 95.75 (Table TEDS 93.42). Docling/Unstructured/PP-StructureV3 were evaluated (per update log) but are not in the v1.6 top leaderboard cut.
- DocLayNet (layout-detection dataset/benchmark, 80,863 annotated pages, 11 classes): https://github.com/DS4SD/DocLayNet ; paper https://arxiv.org/abs/2206.01062
- LlamaIndex readers: Marker `llama-index-readers-pdf-marker` (https://pypi.org/project/llama-index-readers-pdf-marker/); Docling native integration (https://docling-project.github.io/docling/integrations/llamaindex/); PyMuPDF `LlamaMarkdownReader` + `PyMuPDFReader` (https://pymupdf.readthedocs.io/en/latest/pymupdf4llm/).
- Docling CPU/GPU + Fargate (CPU-only; Fargate has no GPU): https://docling-project.github.io/docling/usage/gpu/ , https://docling-project.github.io/docling/usage/api_server/deployment/ , AWS Fargate https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html

## Sources
- Kept (primary): datalab-to/marker, docling-project/docling, pymupdf/pymupdf4llm, Unstructured-IO/unstructured, facebookresearch/nougat, opendatalab/MinerU, opendatalab/OmniDocBench — each directly verifies the claim it supports (license, output, CPU/GPU, benchmark).
- Kept (benchmark/secondary): DS4SD/DocLayNet, the official Docling/PyMuPDF/Unstructured docs pages, LlamaIndex reader PyPI pages.
- Dropped: generic "best PDF parser 2025" listicles, Medium/Reddit commentary, AI-synthesis comparison sites — used only to locate primary sources, not cited as evidence.

## Gaps & confidence
- **Confidence: High** on license, output format, CPU/GPU feasibility, and LlamaIndex-readiness for all six named tools (verified against each repo's README/LICENSE badge + OmniDocBench). **Medium** on relative *accuracy ranking*: the only independent end-to-end benchmark (OmniDocBench v1.6) places MinerU-Pipeline > Marker, but Docling, Unstructured, and PyMuPDF4LLM are **not** on the current v1.6 leaderboard cut, so direct Docling-vs-Marker numbers on this benchmark weren't available in the repo (older update-log entries say Docling/Unstructured were evaluated in v1.0/v1.5). Marker's published win over Docling is **vendor-authored**, so treat it cautiously.
- **Unverified specifics:** exact GitHub star counts and last-commit timestamps were not individually captured (repos described as "very active" / "active" / "slowed" are based on update logs, version numbers, and maintainer signals, not a freshly-queried API). Recommend pulling live stargazer/last-commit data before final vendor scoring.
- **License posture for WRI:** Marker (GPL + OpenRAIL-M, commercial self-host needs paid license) and PyMuPDF4LLM (AGPL-3.0) both need legal review for a public-facing self-hosted service; WRI's nonprofit/research status *may* qualify for Marker's free research/startup terms but "commercial self-hosting requires a license." Docling (MIT), MinerU (Apache-2.0-based), and Unstructured (Apache-2.0) are the low-risk choices.
- **Suggested next step:** a small bake-off on 10–20 real WRI PDFs (mix of born-digital + scanned, multi-column, with tables) comparing Docling vs MinerU-pipeline vs PyMuPDF4LLM on (a) table fidelity, (b) multi-column reading order, (c) CPU pages/sec on a Fargate-sized task, and (d) chunk/JSON shape compatibility with the existing `document_chunks` pipeline. This is the single most decision-relevant test and resolves the Docling-vs-Marker accuracy gap that the public benchmarks leave open.

---
*Research lane brief produced 2026-07-02 by the `researcher` subagent (web-sourced). Subagent coordination trailers trimmed for the team commit.*
