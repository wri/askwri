# Research: Scholarly / Scientific Paper Structure Extractors for WRI RAG Ingestion

## KEY QUESTION — Is dedicated paper-structure parsing worth it for WRI reports vs a good general layout parser?

**Answer: Split decision — YES to structure parsing in general; NO to *requiring* a dedicated *scholarly* parser for the chunking goal; conditional YES to GROBID only if reference/citation semantics are in scope.**

- WRI working papers / reports / data briefs are multi-column, table-heavy, with explicit sections (Executive Summary → Findings → Recommendations → References) and long bibliographies. The current LlamaIndex `PDFReader` (pypdf text-layer) emits **flat text + page boundaries**. That fails four ways that each hurt RAG: (1) scrambles **multi-column reading order**, (2) has **no section boundaries** so 400/80 chunks split mid-section and lose heading context, (3) embeds **reference lists as content** (retrieval noise), and (4) garbles **tables**. Fixing these is worth it.
- For goals (1), (2), and (4) — the RAG *chunking* goal — a **good general layout+structure parser** (Docling) captures ~all the value, runs on CPU, is MIT-licensed, Python-native, and already has a LlamaIndex reader + native chunkers. You do **not** need a scholarly-specific parser for this.
- For goal (3) — *reference* semantics — a general layout parser can *detect* the references section (via section labels) and let you strip/tag it, but only **GROBID** parses references into structured fields (author/title/year/DOI) and links citation callouts. That is worth adding **only if** citation-aware retrieval / reference-stripping-by-structure becomes a goal, not for plain chunking.
- The older dedicated scholarly tools (S2ORC/doc2json, ScienceParse, CERMINE, Crossref pdf-extract) are either low-maintenance, abandoned, or retired; none is a better starting point than "GROBID directly" for the scholarly path, or "Docling" for the general path.

**Net recommendation:** Adopt structure parsing — yes. Primary investment = a general layout parser (**Docling**) as the new base extraction layer. Add **GROBID** as an optional references-only layer when citation/reference handling is prioritized. **Skip** S2ORC/doc2json, ScienceParse, Nougat-as-structure-parser, CERMINE, and Crossref pdf-extract.

**Tools most worth trying: 1) Docling (base structure layer), 2) GROBID (references layer, conditional).**

Confidence: **Medium-high.** Strong on tool capabilities, licenses, deployment, and the GROBID-vs-Docling role split. Lower on quantified accuracy of Docling/Marker on *policy-report* PDFs specifically (benchmarks are mostly arXiv/PMC/mixed business docs, not WRI-style reports).

---

## Summary
Dedicated scholarly paper parsers (GROBID, S2ORC) are built to extract title/authors/abstract/sections/references/figures/tables from scientific PDFs into TEI XML or S2ORC JSON — things generic PDF text extractors cannot do. For WRI's RAG ingestion, the section-structure + reference-section wins are real, but the heaviest lift (multi-column order, section boundaries, tables) is delivered by a modern general layout parser (Docling) that is lighter to deploy than the scholarly stack; GROBID remains uniquely valuable only for structured reference/citation parsing.

---

## Findings

1. **GROBID is the canonical scholarly parser and the only mature open-source tool that parses references into structured fields at high accuracy.** It extracts header (title/abstract/authors/affiliations/keywords), full-text structure (sections, paragraphs, reference markers, figure/table captions, notes), and bibliography, outputting **TEI XML** (loss-less canonical format). Reference parsing reaches **~0.87 F1 on a 1,943-PDF PubMed Central set and ~0.90 F1 on a 2,000-PDF bioRxiv set** using the Deep-Learning citation model (>0.90 instance-level / 0.95 field-level for isolated references). A 2023 benchmark ranks GROBID best for metadata + reference extraction, ahead of CERMINE and ScienceParse; a 2024 comparison puts GROBID and AnyStyle best overall. [GROBID README](https://github.com/kermitt2/grobid) · [End-to-end eval](https://grobid.readthedocs.io/en/latest/End-to-end-evaluation/) · [2023 benchmark](https://arxiv.org/abs/2303.09957)

2. **GROBID deploys as a Dockerized Java REST service with a Python client — usable as a layer, but it is a separate JVM service, not a pip import.** License **Apache 2.0**. Requires **OpenJDK 21**; Deep-Learning models (via DeLFT + JEP) need **Python 3.10–3.11** and ideally a GPU, but the default CRF backend runs CPU-only "out of the box" (use the `-crf` Docker tag, e.g. `grobid/grobid:0.9.0-crf`, REST on port 8070). Official `grobid-client-python` supports batch/concurrent processing and can emit JSON/Markdown in addition to TEI — convenient for RAG. There is **no first-party LlamaIndex GROBID reader**; integration is a custom ingestion step (PDF → GROBID REST → Markdown/JSON → LlamaIndex `Document`s). Production users include Semantic Scholar, ResearchGate, HAL, scite.ai, Internet Archive Scholar. Actively maintained (kermitt2). [GROBID README](https://github.com/kermitt2/grobid) · [grobid-client-python](https://github.com/grobidOrg/grobid-client-python)

3. **S2ORC is now a Semantic Scholar API dataset; its parser `doc2json` is low-maintenance and just wraps GROBID.** The S2ORC corpus (license **ODC-By 1.0**) moved to the Semantic Scholar Public API in Jan 2023 as a bulk dataset; the standalone parser repo `allenai/s2orc-doc2json` was last meaningfully active Aug 2023 (a PR to bump GROBID to **0.7.3**) and pins to that older GROBID version. Its PDF pipeline calls GROBID under the hood and reshapes TEI into the **S2ORC JSON schema** (`abstract`, `body_text`, `back_matter`, paragraph objects with section names + citation spans). For WRI this means: if you want S2ORC-style JSON, you can run GROBID directly and map TEI→JSON yourself rather than depend on a stagnant wrapper. [s2orc README](https://github.com/allenai/s2orc) · [doc2json activity/GROBID dependency](https://github.com/allenai/s2orc-doc2json/activity)

4. **ScienceParse is effectively abandoned and was itself inspired by GROBID.** AllenAI's `science-parse` (Scala/Java hybrid, **Apache 2.0**, JSON output: title/authors/abstract/sections/bibliography/mentions) reached v3.0.0 and points to a "new version SPv2" at `allenai/spv2`, but both are old/inactive with no recent maintenance. Its own README credits `kermitt2/grobid` as inspiration. Not worth adopting for new work. [science-parse README](https://github.com/allenai/science-parse)

5. **Nougat (Meta) is a vision-to-markdown model strong on math/tables but a poor fit for WRI's needs and stack.** License **MIT (code) / CC-BY-NC (weights — non-commercial)**. It is an image-Transformer→text-Transformer that outputs **Mathpix-Markdown (.mmd)**, trained on **arXiv + PMC English scientific papers** (Chinese/Russian/Japanese won't work; best on English scientific layout). It does **not** produce structured reference/bibliographic parsing. It is **GPU-oriented** — on CPU it is slow and prone to `[MISSING_PAGE]` false positives (the FAQ itself recommends `--no-skipping` on CPU/old GPUs). CC-BY-NC weights + GPU dependence make it unsuitable for a CPU Fargate commercial worker. [Nougat README](https://github.com/facebookresearch/nougat) · [paper](https://arxiv.org/abs/2308.13418)

6. **Marker is the strongest "PDF→Markdown/JSON/chunks" production tool, but its license is restrictive for commercial use.** `datalab-to/marker` (Vik Paruchuri / Datalab): **GPL-3.0 code, OpenRAIL-M model weights** (free for research/personal/startups under $2M funding/revenue; commercial self-hosting requires a paid license). Python 3.10+, `pip install marker-pdf`, runs on GPU/CPU/MPS, optionally boosts accuracy with an LLM (`--use_llm`, defaults to `gemini-2.0-flash`; can use Ollama) for tables/math/forms, has a reference processor, and outputs `markdown|json|html|chunks`. Very actively maintained and benchmarks favorably vs LlamaParse/Mathpix/olmocr/Docling. The GPL + commercial-license requirement is the main blocker for an internal WRI/ECS deployment without a commercial agreement. [Marker README](https://github.com/datalab-to/marker)

7. **Docling (IBM) is the best fit for WRI's stated stack and the recommended base layer.** `docling-project` is **MIT-licensed** (docling-parse; Granite-Docling model is Apache 2.0), Python, has an explicit **CPU install** path (`pip install docling --extra-index-url https://download.pytorch.org/whl/cpu`), layout-analysis + table-structure models (AAAI 2025), and — critically for this stack — a first-party LlamaIndex integration (`llama-index-readers-docling`, `from llama_index.readers.docling import DoclingReader`) plus **native chunkers** (`HierarchicalChunker`, `HybridChunker`) that produce structure-aware, metadata-rich chunks directly suitable for RAG ingestion. It is a *general* layout+structure parser (Markdown/JSON/DoclingDocument), not a scholarly reference parser — but it solves multi-column reading order, section/heading structure, and tables, which are the chunking wins WRI needs. [Docling chunking](https://docling-project.github.io/docling/concepts/chunking/) · [LlamaIndex reader](https://pypi.org/project/llama-index-readers-docling/) · [AAAI 2025 paper](https://arxiv.org/abs/2501.17887)

8. **MinerU (Shanghai AI Lab / opendatalab) is strong but wrong-shaped for CPU Fargate.** Open-source PDF/document parser using PDF-Extract-Kit; MinerU2.5 is a **1.2B vision-language model** for high-resolution parsing (outperforms Gemini-2.5-Pro on parsing benchmarks per third-party reports), Python 3.10–3.13. License is a **custom "MinerU Open Source License"** (Apache-2.0-based with extra conditions — needs legal review for commercial use). GPU-oriented VLM inference is a poor fit for CPU-only ECS Fargate. Better suited to a GPU batch-preprocessing sidecar if maximal layout/figure/table fidelity is ever needed. [MinerU repo](https://github.com/opendatalab/MinerU) · [MinerU paper](https://arxiv.org/abs/2409.18839)

9. **Older/secondary reference tools — CERMINE, Crossref pdf-extract, AnyStyle, pdffigures2.** CERMINE (Java, 2015) is the perennial #2 to GROBID for scholarly metadata+references, less actively maintained. Crossref's `pdfextract` is **retired** (Crossref itself recommends CERMINE). AnyStyle (`inukshuk/anystyle`, Ruby, **BSD-2-Clause**) parses bibliography references only — not full structure — and tied with GROBID for best overall in a 2024 reference-parser comparison; relevant only if you want a lightweight reference-only post-processor. `allenai/pdffigures2` (Scala) extracts figures/captions only and is a sub-component (Nougat uses it for dataset generation), not an end-to-end parser. [CERMINE](https://link.springer.com/article/10.1007/s10032-015-0249-8) · [Crossref pdfextract (retired)](https://www.crossref.org/labs/pdfextract/) · [AnyStyle](https://github.com/inukshuk/anystyle) · [pdffigures2](https://github.com/allenai/pdffigures2)

---

## Per-tool section

### GROBID — `kermitt2/grobid`
- **What generic parsers don't:** full scholarly structure — header metadata, hierarchical body sections, reference markers + callout linking, figure/table captions, notes, funding, license; reference entries parsed to author/title/year/DOI. Output **TEI XML** (canonical), with JSON/BibTeX export via the REST service and Markdown/JSON via the Python client.
- **License:** Apache 2.0.
- **Deployment:** Java (OpenJDK 21), official Docker images (`grobid/grobid:0.9.0-crf` for CPU; DL image preconfigured for references). REST API on :8070. DL models optional (DeLFT via JEP, Python 3.10–3.11, GPU recommended for speed; CRF default needs no GPU). Maintained by kermitt2; production deployments at Semantic Scholar, ResearchGate, HAL, scite.ai.
- **Output schema:** TEI XML (also JATS-adjacent; convertible). ~68 fine-grained labels.
- **Reference accuracy:** ~0.87–0.90 F1 end-to-end (DL model); >0.90 instance / 0.95 field-level isolated. Best-in-class across 2023–2024 benchmarks.
- **Fit as a layer on the Python/LlamaIndex worker:** Yes, but as a **separate Docker sidecar service** called from the worker (not a pip import). No native LlamaIndex reader — custom ingestion step. Fits ECS Fargate as a second container/service in the task definition; CPU-only viable with the CRF backend (slightly lower reference accuracy than DL).
- **GitHub:** https://github.com/kermitt2/grobid · client: https://github.com/grobidOrg/grobid-client-python
- **Maintenance:** Active; current (0.9.x line), regular releases.

### S2ORC + doc2json — `allenai/s2orc` / `allenai/s2orc-doc2json`
- **What generic parsers don't:** S2ORC JSON schema (abstract / body_text / back_matter, paragraph objects with section names + inline citation spans + bib entry links) designed for NLP/RAG over papers.
- **License:** S2ORC corpus = ODC-By 1.0; doc2json code = Apache 2.0.
- **Deployment:** `doc2json` runs a **GROBID service** (pinned ~0.7.3) plus Python; effectively a wrapper around GROBID + a LaTeX path. Last real activity Aug 2023; low-maintenance.
- **Output schema:** S2ORC JSON.
- **Reference accuracy:** Inherits GROBID's; the doc2json layer only reshapes, so ≈ GROBID 0.7.3 quality.
- **Fit as a layer:** Technically yes, but redundant — you'd be running GROBID anyway. Prefer calling GROBID directly and mapping TEI→S2ORC-like JSON yourself to avoid a stale dependency.
- **GitHub:** https://github.com/allenai/s2orc · https://github.com/allenai/s2orc-doc2json
- **Maintenance:** Corpus now maintained via Semantic Scholar API; the doc2json parser is effectively dormant.

### ScienceParse — `allenai/science-parse`
- **What generic parsers don't:** title/authors/abstract/sections (heading+body)/bibliography/mentions in one JSON payload.
- **License:** Apache 2.0.
- **Deployment:** Scala/Java hybrid, sbt build, JVM server/CLI/library; v3.0.0. Downloads large model files on first run.
- **Output schema:** JSON (custom).
- **Reference accuracy:** CRF-based; below GROBID in benchmarks.
- **Fit as a layer:** JVM service — same sidecar shape as GROBID but with no advantage and worse maintenance.
- **GitHub:** https://github.com/allenai/science-parse
- **Maintenance:** Inactive; superseded by `allenai/spv2` (also inactive). Not recommended.

### Nougat — `facebookresearch/nougat`
- **What generic parsers don't:** vision-based OCR that preserves **LaTeX math and tables** as Markdown, including for pages with no good text layer.
- **License:** MIT (code) / **CC-BY-NC (weights — non-commercial)**.
- **Deployment:** Python 3.9+, `pip install nougat-ocr`, has an API server (`nougat_api`, :8503). **GPU strongly preferred**; CPU is slow and triggers `[MISSING_PAGE]` false positives. Trained on arXiv/PMC English papers — weak on non-English / non-scientific layout.
- **Output schema:** Mathpix-Markdown (.mmd) — flat Markdown, **not** structured sections/references.
- **Reference accuracy:** N/A — does not parse references.
- **Fit as a layer:** Could run as a sidecar, but CC-BY-NC weights + GPU need + no reference parsing make it a poor fit for WRI's CPU commercial worker. Consider only for scanned-page math/table rescue, on a GPU host.
- **GitHub:** https://github.com/facebookresearch/nougat
- **Maintenance:** Released 2023; limited recent activity; the maintained successor direction is Marker/surya-style tooling.

### Marker — `datalab-to/marker`
- **What generic parsers don't:** high-accuracy PDF→Markdown/JSON/chunks/HTML with table/figure/equation/form/reference handling, artifact cleanup, optional LLM boost, and structured element classes (SectionHeader, Table, Figure, Footnote, ListItem).
- **License:** **GPL-3.0 (code)** + **OpenRAIL-M (weights)** — commercial self-hosting requires a Datalab license.
- **Deployment:** Python 3.10+, `pip install marker-pdf`, GPU/CPU/MPS, optional `--use_llm` (Gemini/Ollama). Streamlit GUI included. Very actively maintained.
- **Output schema:** Markdown / JSON / HTML / **chunks**.
- **Reference accuracy:** Has a `reference` processor (formats references) but does **not** parse them into structured fields like GROBID; it's a layout/markdown tool, not a bibliographic parser.
- **Fit as a layer:** Excellent fit technically (pip, Python, chunk output), but the **GPL + commercial-license requirement** is a real blocker for an internal WRI deployment unless WRI obtains a commercial license. If licensing is acceptable, Marker is a strong alternative to Docling (better on messy/scanned tables and math).
- **GitHub:** https://github.com/datalab-to/marker
- **Maintenance:** Active, frequent releases, public benchmarks.

### Docling — `docling-project` (IBM)  ← recommended base layer
- **What generic parsers don't (vs pypdf):** layout-aware reading order (fixes multi-column), section/heading structure, table-structure recognition, figure/caption detection, and **native structure-aware chunkers** producing metadata-rich chunks.
- **License:** **MIT** (docling-parse; code). Granite-Docling model is Apache 2.0.
- **Deployment:** Python, explicit **CPU install**, `pip install docling`. IBM-backed, AAAI 2025, actively maintained. **First-party LlamaIndex reader** (`llama-index-readers-docling`, `DoclingReader`).
- **Output schema:** `DoclingDocument` (JSON) / Markdown; structured elements.
- **Reference accuracy:** Detects a references *section* but does **not** parse individual reference fields — that's GROBID's job.
- **Fit as a layer:** Best-in-class for this stack — replaces the flat `PDFReader` directly inside the existing Python/LlamaIndex worker on CPU, with native chunking. No second service required.
- **GitHub:** https://github.com/docling-project/docling
- **Maintenance:** Active, IBM-supported, regular releases.

### MinerU — `opendatalab/MinerU`
- **What generic parsers don't:** very high-fidelity layout/figure/table/formula extraction; MinerU2.5 is a 1.2B VLM that tops some parsing benchmarks.
- **License:** Custom "MinerU Open Source License" (Apache-2.0-based + extra conditions) — needs legal review for commercial use.
- **Deployment:** Python 3.10–3.13, `pip`/`uv`, **GPU-oriented** VLM inference.
- **Output schema:** Markdown / JSON.
- **Reference accuracy:** Layout/structure focus; not a bibliographic reference parser.
- **Fit as a layer:** Wrong-shaped for CPU Fargate (GPU VLM). Consider only as an optional GPU batch sidecar for hard scanned reports.
- **GitHub:** https://github.com/opendatalab/MinerU
- **Maintenance:** Active, fast-moving.

### Secondary tools (one line each)
- **CERMINE** — Java scholarly metadata+references, 2015, perennial #2 to GROBID, less maintained. [Springer](https://link.springer.com/article/10.1007/s10032-015-0249-8)
- **Crossref pdf-extract (`CrossRef/pdfextract`)** — **retired**; Crossref recommends CERMINE. [Crossref Labs](https://www.crossref.org/labs/pdfextract/)
- **AnyStyle (`inukshuk/anystyle`)** — Ruby, BSD-2-Clause, **references only**; tied with GROBID for best in a 2024 comparison; option for a lightweight reference-only post-processor. [anystyle.io](https://anystyle.io/)
- **pdffigures2 (`allenai/pdffigures2`)** — Scala, figures/captions only; a sub-component (Nougat uses it), not end-to-end. [GitHub](https://github.com/allenai/pdffigures2)

---

## Recommended path for WRI (how the layers compose)

```
PDF → [Docling]  →  DoclingDocument (sections, tables, reading order)
                  →  HierarchicalChunker/HybridChunker → chunks w/ section metadata
                  →  (strip/tag detected "References" section before chunking to cut noise)
                  →  existing embed + hybrid BM25+dense RAG (400/80 → replaced by Docling chunks)

Optional references layer (when citation-aware retrieval is wanted):
PDF → [GROBID sidecar, CRF on CPU] → TEI XML → references (author/title/year/DOI) + citation callouts
```

- **Phase 1 (chunking win):** swap `PDFReader` for `DoclingReader` + a Docling chunker. Low risk, MIT, CPU, LlamaIndex-native. Expected gains: correct multi-column order, section-aware chunk boundaries, table preservation, less reference-list noise.
- **Phase 2 (references win, conditional):** add a GROBID Docker sidecar (CRF backend, CPU) for structured reference parsing + callout linking — only if citation/reference semantics justify the extra JVM service. Optionally run AnyStyle as a lightweight reference-only alternative if you only need bibliography entries and not callout linking.

---

## Sources

### Kept (primary)
- **kermitt2/grobid README** (https://github.com/kermitt2/grobid) — capabilities, Apache 2.0 license, JDK 21, CRF/DL models, ref F1 ~0.87–0.90, production deployments.
- **grobid-client-python** (https://github.com/grobidOrg/grobid-client-python) — official Python client, batch, JSON/Markdown output.
- **allenai/s2orc README** (https://github.com/allenai/s2orc) — ODC-By, moved to S2 API Jan 2023.
- **allenai/s2orc-doc2json activity** (https://github.com/allenai/s2orc-doc2json/activity) — GROBID 0.7.3 pin, Aug 2023 last activity → low-maintenance.
- **allenai/science-parse README** (https://github.com/allenai/science-parse) — Apache 2.0, Scala/Java, v3.0.0, credits GROBID, SPv2 pointer → inactive.
- **facebookresearch/nougat README** (https://github.com/facebookresearch/nougat) — MIT code / CC-BY-NC weights, vision→Markdown, GPU-needed, arXiv/PMC English only.
- **datalab-to/marker README** (https://github.com/datalab-to/marker) — GPL-3.0 + OpenRAIL-M, Python, optional LLM, chunks output, commercial license required.
- **Docling chunking docs** (https://docling-project.github.io/docling/concepts/chunking/) + **llama-index-readers-docling** (https://pypi.org/project/llama-index-readers-docling/) — MIT, CPU install, native chunkers, LlamaIndex reader.
- **Docling AAAI 2025 paper** (https://arxiv.org/abs/2501.17887) — layout + table-structure models.
- **opendatalab/MinerU** (https://github.com/opendatalab/MinerU) + **MinerU paper** (https://arxiv.org/abs/2409.18839) — custom license, GPU VLM.
- **2023 PDF-extraction benchmark** (https://arxiv.org/abs/2303.09957) — GROBID > CERMINE > ScienceParse for metadata+references.
- **CERMINE** (https://link.springer.com/article/10.1007/s10032-015-0249-8) · **Crossref pdfextract (retired)** (https://www.crossref.org/labs/pdfextract/) · **AnyStyle** (https://anystyle.io/) · **pdffigures2** (https://github.com/allenai/pdffigures2).

### Dropped
- Reddit/HN threads, SEO "top 10 PDF parsers" listicles, ResearchGate summaries — commentary, not primary; excluded to avoid second-hand claims.
- `grobid2json` PyPI package (Feb 2024) — a third-party extraction of doc2json's XML→JSON; redundant given the direct-GROBID recommendation.
- Old S2ORC ACL 2020 PDF mirrors — superseded by the current GitHub README + API status.
- Vendor benchmark pages (LlamaParse/Mathpix) — self-interested; relied on Marker's own published benchmarks only as directional.

---

## Gaps
- **No benchmark on WRI-style policy reports specifically.** All cited accuracy numbers are arXiv/PMC/bioRxiv (GROBID) or mixed business/arXiv docs (Docling, Marker). WRI reports are policy/scientific hybrids with custom section headings ("Key Findings", "Recommendations", boxes/sidebar callouts) — accuracy of section labeling and reference detection on this exact corpus is unverified. Suggest a 20–30 paper smoke test against WRI's own eval golden set (`evaluation/`).
- **GROBID on CPU/Fargate throughput unverified.** CRF backend is CPU-runnable but end-to-end fulltext parsing latency per multi-column 60-page WRI report under Fargate CPU limits is unknown; needs a load test. DL backend (higher ref accuracy) is impractical without GPU.
- **Docling's reference-section detection reliability** on WRI reports (vs. just table/section structure) is not separately benchmarked; if unreliable, GROBID becomes more necessary even for the strip-references use case.
- **License clarity for Marker commercial use** — confirm with WRI legal whether an internal research-product deployment needs the Datalab commercial license before considering Marker over Docling.
- **MinerU custom-license terms** not legally parsed — only flagged as Apache-2.0-based + conditions.

Suggested next steps: (1) 30-paper WRI smoke test comparing current pypdf vs Docling on chunk quality + reference-section detection; (2) parallel GROBID CRF sidecar test on the same 30 for reference recall/precision; (3) decide Phase-2 (GROBID) go/no-go based on whether reference-section noise materially hurts the existing `eval:cite` / `eval:answer-retrieval` scores.

---

## Confidence
**Medium-high** on tool capabilities, licenses, deployment shape, and the GROBID (references) vs Docling (structure) role split. **Medium** on quantified benefit to WRI's RAG specifically (benchmarks are not on WRI-style reports; a corpus-specific smoke test is needed before committing to GROBID's extra ops cost).
---
*Research lane brief produced 2026-07-02 by the `researcher` subagent (web-sourced). Subagent coordination trailers trimmed for the team commit.*
