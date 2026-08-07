# Research: OCR for Scanned / Image-Heavy Legacy PDFs (WRI corpus)

> Scope: ONLY the parsing/OCR stage for the Python ingestion worker. Context: worker uses
> LlamaIndex `PDFReader` (wraps `pypdf`, text-layer only); scanned PDFs yield empty/garbage
> text and fall through to `needs_review`. Stack = Python 3.12, FastAPI, ECS Fargate **CPU**,
> RDS Postgres + pgvector. Corpus = WRI research reports (older scans, multi-column, tables,
> figures; not handwriting).

## Summary

**Recommendation: keep the existing `PDFReader`/`pypdf` path UNCHANGED and add `ocrmypdf` as a
CPU pre-process step** — detect text-layer coverage per document, and for scanned/low-coverage
PDFs run `ocrmypdf --skip-text --deskew --rotate-pages -l eng` to produce a *searchable PDF*
with a hidden text layer, which `pypdf` then extracts normally. This is the minimal-pipeline-
change, CPU-realistic-on-Fargate option. Full parser replacements (Surya 2, PaddleOCR-VL, Nougat)
are far more accurate on complex layouts but are GPU/heavy-model workloads that are **not
realistic on Fargate CPU** at batch scale; treat them as an optional, separate GPU escalation
lane for the hard residual cases, not the default.

## Recommended Strategy (concrete)

1. **Detect text-layer coverage** upstream of parsing, per document (cheap, CPU-only):
   - `PdfReader(path)` → sum `len((page.extract_text() or "").strip())` across pages.
   - If total chars ≥ threshold (e.g. ~50 chars/page average, tunable) → **text layer present** →
     run the *existing* `PDFReader` path unchanged.
   - If near-empty → **scanned / image-only** → route to the new OCR pre-process step.
   - This mirrors what `pypdf`'s own docs say: it cannot read image text, and empty extraction is
     the signal that OCR is needed. [[pypdf extract-text docs](https://pypdf.readthedocs.io/en/3.12.2/user/extract-text.html)]
2. **OCR pre-process via `ocrmypdf`** (Tesseract under the hood) on the scanned subset:
   - `ocrmypdf --skip-text --deskew --rotate-pages --output-type pdfa -l eng in.pdf out.pdf`
   - `--skip-text` is the key flag for WRI's **mixed** PDFs: it OCRs only the image-only pages and
     leaves digital-text pages untouched (preserves vector quality, saves CPU). [[ocrmypdf advanced](https://ocrmypdf.readthedocs.io/en/stable/advanced.html)]
   - Output is a PDF/A with the OCR text placed *under* the page image → `pypdf`/`PDFReader`
     consumes it **with zero code change** to the parser, chunker, or RAG contract.
   - Avoid `--force-ocr` by default (rasterizes even good text pages → quality loss + slower);
     reserve it for "digital PDF with a garbage text layer."
3. **Feed the OCR'd PDF into the unchanged `PDFReader` path.** No new chunking, no new schema, no
   change to `QueryRequest`/`QueryResponse`. Existing `needs_review` queue should shrink.
4. **Optional escalation lane (separate workstream, GPU)** for the minority of scanned reports
   where Tesseract quality on tables/multi-column is too poor for retrieval: Surya 2 or
   PaddleOCR-VL as a layout-aware re-parse. Not the default; not on Fargate CPU.

### Strategy comparison (the design question, answered)

| Dimension | **ocrmypdf pre-process (REC)** | Full parser replacement (Surya/Paddle-VL/Nougat) | Always-run layout-OCR (Surya default) |
|---|---|---|---|
| Text-layer detection | pypdf extraction test; `--skip-text` handles mixed internally | N/A — replaces the whole parse | N/A — runs on every page |
| CPU realism on Fargate | ✅ **CPU-native**, multi-core, battle-tested; no GPU | ⚠️ Surya2=650M (vllm/llama.cpp), Nougat=transformer — slow/ill-suited on CPU batch | ❌ same; pays OCR cost on *all* docs incl. clean digital ones |
| Accuracy on report pages (multi-col/tables) | ⚠️ Tesseract weak on tables/columns w/o PSM tuning + deskew; OK for retrieval-grade text | ✅ Surya/Paddle-VL strong on layout, reading order, tables | ✅ best, but overkill & costly for the majority clean-text docs |
| Minimal pipeline change | ✅ **Smallest** — new pre-step only; parser/chunker/RAG untouched | ❌ New framework, new output schema, new chunking | ❌ Reroutes every doc; biggest blast radius |
| License friction | ✅ MPL-2.0 (ocrmypdf) + Apache-2.0 (Tesseract) | ⚠️ Surya GPL-3.0 code + restricted weights; Nougat CC-BY-NC weights | same as col 2 |
| New system deps | Tesseract + Ghostscript + lang packs in the ECS image | model weights, GPU runtime, heavier image | model weights, GPU runtime |

**Why pre-process wins for AskWRI:** the only infra change is adding `tesseract-ocr`,
`ghostscript`, and a Tesseract language pack to the worker's container image plus a `pip install
ocrmypdf`. The parser, the `document_chunks` ownership boundary, the `/query` contract, and the
400/80 chunking are all untouched. Retrieval is tolerant of imperfect reading order, which
neutralizes Tesseract's main weakness for RAG purposes; the hard cases escalate to a GPU lane.

---

## Per-Tool Section

### 1. OCRmyPDF (`ocrmypdf`) — **the recommended tool**
- **What:** CLI + Python API that adds a searchable OCR text layer to scanned PDFs (PDF/A output,
  text placed under the page image). Wraps **Tesseract** for recognition and **Ghostscript**/
  `pypdfium2` for rasterization; deskews, rotates, and optimizes. Pure-Python orchestration.
- **License:** **MPL-2.0** (verified in repo `LICENSE` + `pyproject.toml` `license="MPL-2.0"`).
- **Python API:** `import ocrmypdf; ocrmypdf.ocr("in.pdf", "out.pdf", skip_text=True,
  deskew=True, rotate_pages=True, language="eng", output_type="pdfa")`; or `subprocess` CLI.
  Requires Python ≥3.11 (✓ 3.12). [[ocrmypdf docs](https://ocrmypdf.readthedocs.io/en/stable/)]
- **CPU vs GPU:** **CPU-native.** "Distributes work across all available CPU cores," "battle-tested
  on millions of PDFs." No GPU needed — ideal for Fargate. [[repo](https://github.com/ocrmypdf/OCRmyPDF)]
- **Accuracy on report pages:** Tesseract-class (see Tesseract below) — good on clean printed
  text, weaker on multi-column/tables without tuning. Mitigated by `--deskew --rotate-pages`
  and `-l eng`. For retrieval (not perfect layout) this is acceptable.
- **Integration mode:** **Pre-process** (the recommended pattern) — its whole purpose is to make a
  PDF that `pypdf` can then read. Has a plugin system; official-ish plugins can swap the engine to
  EasyOCR (`OCRmyPDF-EasyOCR`) or PaddleOCR (`ocrmypdf-paddleocr`) if a GPU ever becomes available.
- **Maintenance:** Active — v17.8.0, Production/Stable, CI builds, regular release notes. [[repo](https://github.com/ocrmypdf/OCRmyPDF)]

### 2. Tesseract / `pytesseract`
- **What:** Tesseract is the C++ OCR engine (the recognition core OCRmyPDF uses). `pytesseract`
  (`madmaze/pytesseract`) is the thin Python wrapper. 100+ language packs.
- **License:** **Apache-2.0** (Tesseract). [[tesseract site](https://tesseractocr.org/)]
- **Python API:** `pytesseract.image_to_string(img, lang="eng", config="--psm 3")` on a rendered
  page image (e.g. via `pdf2image`/`pypdfium2`). Lower-level than ocrmypdf — you handle rendering,
  segmentation, and reassembly yourself.
- **CPU vs GPU:** **CPU-oriented** C++ engine; realistic on Fargate. Throughput depends on DPI,
  `--psm`, and page count.
- **Accuracy on report pages:** Official guidance is blunt — **skew kills accuracy**, **tables are
  a known weakness without custom segmentation**, and the wrong Page Segmentation Mode (e.g.
  `PSM 4` = single column) degrades multi-column pages. Needs deskew + binarization + correct
  `--psm`. [[ImproveQuality docs](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html)]
- **Integration mode:** Either (a) **indirectly via ocrmypdf** (recommended — ocrmypdf does the
  rendering/deskew/reassembly for you and emits a pypdf-readable PDF), or (b) direct per-page
  `pytesseract` calls (more code, you own reading order).
- **Maintenance:** Tesseract is mature/active; `pytesseract` is a stable, lightly-updated wrapper.
  [[tesseract repo wiki](https://github.com/tesseract-ocr/tesseract/wiki/ImproveQuality)]

### 3. Surya (`datalab-to/surya`, formerly `VikParuchuri/surya`) — GPU escalation lane
- **What:** Layout analysis + OCR + reading order + table recognition in 90+ languages. **Surya 2**
  is a single **650M-parameter model** doing OCR/layout/tables (lighter text-detection + OCR-error
  models remain separate). [[releases](https://github.com/datalab-to/surya/releases)]
- **License:** ⚠️ **Code: GPL-3.0-or-later**; **model weights: modified AI Pubs Open Rail-M**
  (free for research/personal/startups under limits). Copyleft code + restricted-weight caveat for
  a production pipeline. [[README](https://github.com/VikParuchuri/surya/blob/master/README.md)]
- **Python API:** `surya-ocr` package; served via **vLLM (GPU)** or **llama.cpp (CPU / Apple
  Silicon)**. [[PyPI](https://pypi.org/project/surya-ocr/)]
- **CPU vs GPU:** Runs without a GPU, but realistic throughput needs one. Official: **5.35
  pages/sec on a single RTX 5090 @ 128 concurrent (vLLM)** — a server-throughput figure, **not**
  CPU latency; **no official CPU pages/sec published**. A 650M transformer via llama.cpp on a
  Fargate CPU task is realistically slow (seconds-to-tens-of-seconds/page). Not a batch-CPU tool.
  [[datalab blog](https://www.datalab.to/blog/surya-2)]
- **Accuracy on report pages:** Strong — explicit layout, reading order, and table recognition;
  claims favorable vs cloud OCR. Best-in-class here among the open options.
- **Integration mode:** **Full parser replacement / always-run layout-OCR** (it owns the whole
  parse → structured text), NOT a "produce searchable PDF → pypdf" step. Biggest pipeline change.
- **Maintenance:** Active — 82 releases, latest v0.20.0 ("Surya 2") May 2025, maintainer issue
  activity into 2025. [[repo](https://github.com/datalab-to/surya)]

### 4. PaddleOCR (`PaddlePaddle/PaddleOCR`) — CPU-possible, also a parser replacement
- **What:** OCR + document-parsing toolkit. Two relevant tracks: **PP-OCRv6** (fast text
  recognition, 100+ langs, tiny/small/medium tiers 1.5M–34.5M) and **PaddleOCR-VL-1.6 (0.9B VLM)**
  + **PP-StructureV3** for layout/tables → Markdown/JSON. 96.3% on OmniDocBench v1.6.
  [[repo](https://github.com/PaddlePaddle/PaddleOCR)]
- **License:** **Apache-2.0** — cleanest of the heavy options.
- **Python API:** `pip install paddleocr`; `PaddleOCR` class / PP-StructureV3 pipeline. Note the
  dependency is the **PaddlePaddle** framework (not PyTorch) — a separate stack in the venv
  (Python 3.8–3.12 supported per the repo badge).
- **CPU vs GPU:** CPU-aware — PP-OCRv6 claims **5.2× CPU speedup (OpenVINO)**, 6.1× on Apple M4,
  0.13s on A100. PP-OCRv6 medium (34.5M) is plausibly CPU-batch-able; the **0.9B PaddleOCR-VL is
  GPU-oriented**. [[benchmark docs](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/instructions/benchmark.en.md)]
- **Accuracy on report pages:** PP-StructureV3/PaddleOCR-VL strong on tables & structure →
  Markdown/JSON. Good for the hard multi-column/table case.
- **Integration mode:** Parser replacement (structured output), OR **as an ocrmypdf engine plugin**
  (`ocrmypdf-paddleocr`) if you want ocrmypdf's pre-process workflow with a stronger recognizer.
- **Maintenance:** Very active — PaddleOCR 3.7.0 (2026-06), PP-OCRv6; heavily used by Dify/RAGFlow.

### 5. EasyOCR (`JaidedAI/EasyOCR`) — usable but weakest fit for reports
- **What:** Ready-to-use PyTorch OCR, 80+ languages, CRAFT/DBNet detection + CRNN recognition.
- **License:** **Apache-2.0** ⚠️ but a `python-bidi` LGPLv3 dependency raises a compliance flag
  (issue #845). [[PyPI](https://pypi.org/project/easyocr/)]
- **Python API:** `easyocr.Reader(['en'], gpu=False); reader.readtext(img)` → bbox + text + conf.
  **Image-based, not PDF-native** — you render pages and reconstruct reading order yourself.
- **CPU vs GPU:** CPU via `gpu=False`; **no official CPU benchmark**; PyTorch-based so heavier
  than Tesseract. [[tutorial](https://www.jaided.ai/easyocr/tutorial/)]
- **Accuracy on report pages:** Good general text OCR, but **no built-in layout / reading-order /
  table handling** → weak on multi-column reports without extra work (would duplicate what Surya/
  Paddle give you for free). ocrmypdf has an EasyOCR plugin, but EasyOCR itself notes "GPU strongly
  recommended."
- **Integration mode:** Parser-replacement-ish (image→text); best used behind ocrmypdf's plugin if
  at all, since it doesn't produce a searchable PDF on its own.
- **Maintenance:** **Lightly maintained** — v1.7.2 (Sept 2024); promised handwriting support still
  pending. Not dead, but slow cadence vs Paddle/Surya. [[repo](https://github.com/JaidedAI/EasyOCR)]

### 6. Nougat (`facebookresearch/nougat`) — academic-paper specialist, not for general report OCR
- **What:** Vision transformer (Swin encoder + autoregressive decoder) that converts a **page
  image** → Mathpix-Markdown (`.mmd`) preserving LaTeX math & tables. Trained on **arXiv/PMC
  scientific papers**. [[paper arXiv:2308.13418](https://arxiv.org/abs/2308.13418)]
- **License:** ⚠️ **Code MIT; model weights CC-BY-NC (non-commercial).** Weights can't be used
  commercially — flag for any paid/SaaS use even if WRI is nonprofit. [[repo](https://github.com/facebookresearch/nougat)]
- **Behavior on scanned pages:** Works **from page images** (not the text layer), so it *can*
  process scanned PDFs in principle — the paper says this "allow[s] access to scanned papers and
  books." BUT it was trained on arXiv/PMC English scientific papers; README FAQ: works best on
  English scientific papers, **"Chinese, Russian, Japanese etc. will not work."**
  [[OpenReview paper](https://openreview.net/pdf/661c0ec6ddf4baaba38565b44443cdde429862ad.pdf)]
- **CPU vs GPU:** **Ill-suited to CPU batch.** README FAQ: failure-detection gives false positives
  "when computing on CPU or older GPUs" (use `--no-skipping`); `--full-precision` may speed CPU.
  Autoregressive generation per page → slow on Fargate CPU. [[repo](https://github.com/facebookresearch/nougat)]
- **Accuracy / hallucination:** Generative — can hallucinate; has a failure-detection heuristic
  (repeated n-grams) and emits `[MISSING_PAGE]`. Not faithful-text OCR; it's a structured-markdown
  generator tuned for math-heavy academic papers.
- **Integration mode:** Full parser replacement → markdown. Heavy, GPU-oriented, narrow domain.
- **Maintenance:** ~dormant/maintenance-only (last model tags 0.1.0-base/small; low recent
  release activity). Not recommended as a default.

### Cloud OCR (cross-reference only — another agent covers this deeply)
Document AI (Google), Textract (AWS), and Mathpix are hosted OCR/structure services that sidestep
the CPU-vs-GPU tradeoff entirely (latency + cost + egress instead) and are strong on tables/
layout. They are an alternative **escalation** lane for hard scanned reports, not a local-Fargate
default. Details are covered by the cloud-APIs research agent.

---

## Evidence Links (primary sources kept)

- **OCRmyPDF** — repo + docs + license verified: <https://github.com/ocrmypdf/OCRmyPDF>
  (`LICENSE` = MPL-2.0; `pyproject.toml` v17.8.0, Python ≥3.11), <https://ocrmypdf.readthedocs.io/en/stable/advanced.html> (`--skip-text`/`--redo-ocr`/`--force-ocr`).
- **pypdf** (text-layer detection rationale): <https://pypdf.readthedocs.io/en/3.12.2/user/extract-text.html>
- **Tesseract** (accuracy/limitations): <https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html>
  (skew, tables, PSM), <https://tesseractocr.org/> (Apache-2.0).
- **Surya** — repo <https://github.com/datalab-to/surya>, releases <https://github.com/datalab-to/surya/releases>,
  README <https://github.com/VikParuchuri/surya/blob/master/README.md> (GPL-3.0 code + restricted weights),
  throughput <https://www.datalab.to/blog/surya-2> (5.35 pg/s RTX 5090/128-concurrent vLLM; no CPU figure).
- **PaddleOCR** — repo <https://github.com/PaddlePaddle/PaddleOCR> (Apache-2.0; PaddleOCR 3.7.0 / PP-OCRv6),
  benchmark <https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/instructions/benchmark.en.md> (CPU 5.2× OpenVINO).
- **EasyOCR** — repo <https://github.com/JaidedAI/EasyOCR> (Apache-2.0, v1.7.2 Sept 2024, lightly maintained),
  PyPI <https://pypi.org/project/easyocr/>, tutorial <https://www.jaided.ai/easyocr/tutorial/> (CPU via `gpu=False`).
- **Nougat** — repo <https://github.com/facebookresearch/nougat> (code MIT / weights CC-BY-NC), paper
  <https://arxiv.org/abs/2308.13418>, OpenReview <https://openreview.net/pdf/661c0ec6ddf4baaba38565b44443cdde429862ad.pdf> (works from page images → scanned OK in principle; arXiv/PMC-English only).

## Confidence & Gaps

**Confidence:**
- **High** on the strategy: ocrmypdf-as-pre-process is the standard, minimal-change, CPU-realistic
  pattern, and `pypdf` consuming its searchable PDF unchanged is well-documented and low-risk.
- **High** that Surya 2 / Nougat are **not** Fargate-CPU-batch-realistic (650M transformer / Swin
  autoregressive; official numbers are GPU-only or absent).
- **Medium** on Tesseract accuracy for the *hardest* multi-column/table scanned WRI reports — its
  documented table/column weakness is the main residual risk; retrieval tolerance mitigates it,
  with an optional GPU escalation lane for true outliers.

**Gaps / suggested next steps:**
1. No controlled 2025/2026 benchmark of Tesseract(ocrmypdf) vs Surya vs PaddleOCR-VL on
   *WRI-style* multi-column scanned report pages — recommend a small pilot on ~20–50 real scanned
   WRI PDFs measuring char-recovery + a retrieval-relevance proxy.
2. No official CPU pages/sec for Surya 2 or Nougat on Fargate-equivalent hardware; if a GPU lane is
   ever pursued, measure actual throughput/cost on a GPU task (or compare to cloud OCR).
3. ocrmypdf Fargate throughput not yet quantified — depends on DPI, page count, `--jobs`, and
   instance vCPU; a pilot should set per-document OCR timeouts to bound worker latency.
4. License review needed before adopting Surya (GPL-3.0 code + restricted weights) or Nougat
   (CC-BY-NC weights) in any path that could be considered commercial/SaaS. ocrmypdf(MPL-2.0)+
   Tesseract(Apache-2.0) and PaddleOCR/EasyOCR (Apache-2.0) are clear.
5. Container-image work not specified here: the worker image needs `tesseract-ocr`, a Tesseract
  language pack (e.g. `tesseract-ocr-eng`), and `ghostscript` added — confirm base image supports it.

---

---
*Research lane brief produced 2026-07-02 by the `researcher` subagent (web-sourced). Subagent coordination trailers trimmed for the team commit.*
