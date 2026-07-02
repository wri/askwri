# Research: Cloud/Commercial PDF Parsing APIs for WRI Research Reports

> Scope: ONLY the PDF → text/markdown/structure parsing stage. Per-page/per-document, HTTP-based commercial APIs. Local libraries (pypdf, pdfplumber, PyMuPDF4LLM, Marker, Docling, etc.) are covered by a sibling agent and are **not** evaluated here except as a cost/privacy comparison baseline.
> Stack context: Python 3.12, FastAPI, LlamaIndex, OpenAI, AWS ECS Fargate. Current parser = LlamaIndex `PDFReader` (wraps `pypdf`, text-layer only — no layout, no tables, no OCR).
> Corpus context: WRI working papers / technical reports / data briefs. Born-digital + older scanned. Multi-column layouts, data tables, charts, references. This is **academic/research-report-style** content, which independent benchmarks identify as the *hardest* document class for any parser.

---

## Summary (ranked recommendation)

**LlamaParse is the clear #1 cloud pick for WRI** because it is a drop-in upgrade from the current `PDFReader` (same LlamaIndex ecosystem, native Python SDK), handles OCR + tables + multi-column layout, and independent 2026 benchmarking (PDFbench, 800+ docs) names it the quality/cost "sweet spot" (78% edit similarity, **81% ChrF++** — highest of any parser tested, 39% tree similarity, ~$0.003/page). It slots directly above the current `PDFReader` in the pipeline with minimal glue code. **Adobe PDF Extract API** is the strongest runner-up when maximum structural fidelity (JSON + markdown + table/image assets + bounding boxes) is required, with the best published privacy posture (≤24h retention, per-transaction US/EU region choice). **Azure AI Document Intelligence** and **Google Cloud Document AI** are mature, well-governed enterprise OCR/layout platforms (both ~$0.01/page for layout, markdown-capable) but require more integration glue and aren't RAG-tuned by default. **AWS Textract** has tenancy affinity with the existing Fargate stack but returns JSON Blocks (not markdown) and retains content for service improvement unless opted out. **Mathpix** and **Mistral OCR** are worth targeted evaluation — Mathpix for equation/science-heavy reports, Mistral OCR as the cheapest option (~$0.001/page).

A critical, honest caveat for WRI: independent benchmarking shows **academic/research-style reports are the hardest document class for every parser** — even the best (Gemini 3 Pro, a frontier LLM) reaches only ~60% edit similarity, and LlamaParse drops to ~38% on that subset. No dedicated parsing API will cleanly recover WRI's densest multi-column data tables. Plan the pipeline for tiered routing (cheap/local for easy born-digital; cloud API for scanned/table-heavy) plus human-in-the-loop QA on critical tables.

---

## Ranked recommendation (cloud options, for WRI)

| Rank | API | Why for WRI | $/page (2025–26) | Output | Privacy posture |
|---|---|---|---|---|---|
| **#1** | **LlamaParse** (LlamaIndex) | Native fit for existing LlamaIndex stack; drop-in upgrade from `PDFReader`; OCR + tables + layout; best quality/cost in independent benchmark; free tier | Free 10k credits/mo (~1k pg); paid ~$0.00125–0.0125/pg by tier (~$0.003 "cost effective") | Markdown + JSON; tables; layout; cell-level bounding boxes | VPC deploy option for enterprise; privacy notice published; retention not publicly specified |
| **#2** | **Adobe PDF Extract API** | Highest structural fidelity (reading order, table/image assets, bbox); best-documented privacy | 500 free tx/mo; paid = contact sales; billed per "Document Transaction" rounded up on 5-page basis | Structured JSON **+** markdown; tables; figures/images; bounding boxes; reading order | ≤24h retention; US-East/EMEA; **per-transaction region choice**; enterprise ETLA/VIP |
| **#3** | **Azure AI Document Intelligence** (fmr. Form Recognizer) | Mature enterprise platform; Layout model outputs markdown; strong governance; prebuilt models don't train on your data | Free 500 pg/mo; Layout $0.01/pg ($10/1k) | JSON; **Layout → markdown**; tables; key-value; bounding boxes | Same-region temp storage; customer-managed keys; prebuilt models don't train on customer data |
| **#4** | **Google Cloud Document AI** | Solid layout parsing + chunking for RAG; regional endpoints; Google doesn't train on customer data | Enterprise OCR $0.0015/pg; Layout Parser $0.01/pg | JSON `Document` object (not native markdown — needs conversion); layout/chunk fields; tables | Regional/multi-regional endpoints; Google won't train on customer data without permission |
| **#5** | **AWS Textract** | Tenancy affinity with existing AWS/Fargate stack; mature OCR + tables + layout | $0.015/pg (tables+layout, first 1M); $0.010/pg over 1M; layout free w/ tables | **JSON Blocks only** (TABLE/CELL/LAYOUT_* block types) — needs a markdown converter | **May store content for service improvement unless opted out**; in-region storage; opt-out via AWS Orgs policy |
| **#6** | **Mathpix** | Best for equation/science-heavy reports; native markdown tables | $0.005/pg (0–1M); $0.0035/pg (1M+); $19.99 one-time setup | Markdown; LaTeX-quality tables; equations | Documented but lighter enterprise posture than hyperscalers |
| **#7** | **Mistral OCR** (2025 emerging) | Cheapest; native markdown + multi-column + table support; batch doubles pages/$ | $0.001/pg; ~$0.0005/pg batch | Markdown (`table_format=markdown`/`html`); multi-column | Mistral cloud; newest entrant — less battle-tested |

> Note on a separate category: independent benchmarking also evaluated **frontier LLMs** as parsers (Gemini 3 Pro, GPT-5.1, Claude Sonnet 4.5). These lead raw text fidelity on the hardest academic-style docs (Gemini 3 Pro = 88% edit sim overall, 60% on academic) but cost 10–60× more, add 10–30s/page latency, and produce non-deterministic structure. They are general LLMs rather than dedicated parsing APIs, so they sit outside the core ranking — but they are the right fallback if WRI needs max fidelity on the hardest reports and can absorb cost/latency. Within budget parsers, LlamaParse and Gemini 2.0 Flash both hit ~78% edit sim; only LlamaParse preserves structure well (39% tree sim vs Flash's 35%).

---

## Per-API detail

### 1. LlamaParse (LlamaIndex) — **Recommended primary**
- **What:** LlamaIndex's managed PDF/document parser, purpose-built for RAG and complex layouts. Direct successor-in-spirit to the basic `PDFReader` you use today; same `llama_parse` Python package, same LlamaIndex reader interface.
- **Pricing:** Free tier = **10,000 credits/month (~1,000 pages)**. Paid = credit-based by parse tier: **Fast ≈ 1 credit/pg, Cost Effective ≈ 3 credits/pg, Agentic ≈ 10 credits/pg** (extraction tiers run 5–15 credits/pg). Credit→USD conversion cited by third parties as ~1,000 credits = $1.25 (≈ $0.00125/credit), yielding roughly **$0.00125/pg (Fast), $0.00375/pg (Cost Effective), $0.0125/pg (Agentic)**. PDFbench reports an effective **~$0.003/page**. ⚠️ LlamaIndex's own pricing page is credit-based and does not publish a clean USD price card — the USD figures are third-party/benchmark-derived (see Gaps).
- **Output:** Markdown + JSON/schema extraction; tables; layout/reading order; recently added **cell-level bounding boxes** (word/line/cell coordinates). Native LlamaIndex `Document` ingestion — minimal glue vs current `PDFReader`.
- **Quality on multi-column research tables:** PDFbench (2026, 800+ docs) — **78% edit similarity, 81% ChrF++ (highest of 17 parsers), 39% tree similarity, ~$0.003/pg**; ranked the quality/cost "sweet spot" and **#1 on ParseBench**. Caveat: on the *academic-paper* subset, LlamaParse drops to ~38% edit sim — so WRI's densest research tables will still degrade (true of every parser).
- **Latency:** Seconds per page (cloud async); not the 10–30s/page of frontier LLMs.
- **Python SDK:** `llama-parse` on PyPI; first-class LlamaIndex reader (`LlamaParse`).
- **Privacy/data handling:** Documents leave your tenancy to LlamaIndex's cloud by default. Enterprise tier supports **"run in our cloud or deploy fully in your VPC"** for data residency. Published privacy notice exists, but a **specific LlamaParse customer-content retention period is not publicly disclosed** — confirm in an enterprise agreement. WRI publishes mostly public reports, so egress risk is low for published material; flag any pre-publication drafts.
- **Fit for WRI:** **Best.** Native stack fit + best benchmarked quality/cost + OCR for scanned reports + layout/tables the current `PDFReader` lacks. The upgrade path is essentially: swap `PDFReader` → `LlamaParse` reader, keep everything else.
- **Tradeoff vs current `PDFReader`:** `PDFReader` is free, local, zero-egress, deterministic — but text-layer-only, no layout/tables/OCR, and silently fails on scanned reports. LlamaParse adds those capabilities at ~$0.003/pg (with a 1k-page/mo free cushion) at the cost of cloud dependency + egress review.
- **Tradeoff vs a local parser (sibling agent's domain):** Local parsers (PyMuPDF4LLM, Docling, Marker) win on privacy, cost-at-scale, and offline control; LlamaParse wins on complex-layout/OCR fidelity and zero ops. Suggested pattern: route easy born-digital text-layer PDFs to a local parser; send scanned + table-heavy + multi-column reports to LlamaParse.

### 2. Adobe PDF Extract API (Acrobat Services) — **Runner-up for max fidelity**
- **What:** Adobe's PDF structure extraction service; positions on high-fidelity reading order, complex tables, figures, and layout metadata.
- **Pricing:** Free tier = **500 Document Transactions/month**. Paid = **contact sales** (no public price card). Billing unit is the "Document Transaction," **rounded up on a 5-page basis** (1–5 pg = 1 tx, 6–10 = 2, …). So a 12-page WRI report = 3 transactions. ⚠️ Opaque unit economics — must negotiate.
- **Output:** Structured `structuredData.json` **and** a markdown conversion path (PDF-to-markdown how-to exists). Includes headings, paragraphs, reading order, **complex tables, figures/images (as separate assets), and bounding boxes**. Strongest raw structural-fidelity story among the dedicated APIs; an academic benchmark found Adobe Extract "outperforms other tools on table extraction" on academic PDFs.
- **Quality on multi-column research tables:** Best-in-class structure preservation story; handles multi-column reading order and complex tables explicitly. Not in the PDFbench main table, but the academic-PDF benchmark result supports strong table performance.
- **Latency:** Async job model; seconds-to-minutes depending on size.
- **Python SDK:** Adobe ships official Python SDK examples (`adobe-pdf-services-sdk`); HTTP/REST also available.
- **Privacy/data handling:** **Best documented.** Documents **never stored permanently**; retained **≤24 hours** during processing. Processing runs in **AWS US-East or EMEA**, and region is **choosable per transaction** (US or EU host). Enterprise via ETLA/VIP.
- **Fit for WRI:** Strong if WRI prioritizes structural fidelity and has appetite for a sales-negotiated contract. More integration glue than LlamaParse (different ecosystem, transaction-based billing), but the per-transaction region choice and 24h retention are the cleanest privacy story for any pre-publication drafts.

### 3. Azure AI Document Intelligence (fmr. Form Recognizer) — **Mature enterprise platform**
- **What:** Microsoft's document-AI platform with Read (OCR), Layout, prebuilt (invoice/receipt/ID/contract), custom extraction, and classification models.
- **Pricing:** Free tier = **500 pages/month** (all models). S0 pay-as-you-go: **Layout (and all prebuilt models) = $10/1,000 pages = $0.01/page**. Read model is cheaper but text-only (no markdown/tables). Billing is per pages analyzed.
- **Output:** JSON by default; the **Layout model returns Markdown**. Includes tables, key-value pairs, selection marks, and bounding boxes.
- **Quality on multi-column research tables:** Solid enterprise-grade layout + table extraction. PDFbench tested Azure Document Intelligence on 200+ docs (didn't break out per-domain scores in the surfaced snippet). Strong on forms/invoices; research-report fidelity good but not benchmark-leading.
- **Latency:** Async; seconds-to-tens-of-seconds per page.
- **Python SDK:** `azure-ai-documentintelligence` (official); first-class.
- **Privacy/data handling:** Uploaded docs + results **temporarily stored in Azure Storage in the same region** as the resource; **prebuilt models do NOT train on customer data**; custom models stored in-region, logically isolated per subscription; supports **customer-managed keys** (key vault + resource same region). Encrypted at rest.
- **Fit for WRI:** Strong enterprise pick if WRI is already in Azure or wants a governed, markdown-emitting platform. Less RAG-tuned out-of-the-box than LlamaParse (no native chunking story) and more integration glue. Best privacy/governance among the hyperscaler options.

### 4. Google Cloud Document AI — **Solid layout + RAG chunking**
- **What:** Google's document-AI family; **Layout Parser** is the relevant processor for structured research-report extraction.
- **Pricing:** **Enterprise Document OCR = $1.50/1,000 pg ($0.0015/pg)** (text only); **Layout Parser = $10/1,000 pg ($0.01/pg)** (layout-aware, includes initial chunking); Custom Splitter = $5/1,000 pg.
- **Output:** Returns a **`Document` JSON object** (not native markdown). Layout Parser populates `documentLayout` blocks (text/table/list/image) and `chunked_document.chunks` — the latter is RAG-friendly. Markdown must be derived from the JSON.
- **Quality on multi-column research tables:** Good layout + table extraction; the built-in chunking is a plus for RAG. PDFbench included Google Document AI among the 4 commercial APIs tested.
- **Latency:** Async; seconds-to-tens-of-seconds.
- **Python SDK:** `google-cloud-documentai` (official).
- **Privacy/data handling:** **Regional/multi-regional** processor endpoints (choose location per request, e.g. `LOCATION-documentai.googleapis.com`). Google's security overview: customer data not sold to third parties, not used to train Google's models without permission.
- **Fit for WRI:** Good if WRI is in GCP or wants the bundled chunking. Main drawback vs LlamaParse: JSON-not-markdown output needs a conversion step, and Google's research-report tuning is less RAG-specialized.

### 5. AWS Textract — **Tenancy affinity, but JSON-only output**
- **What:** AWS OCR/layout service; `AnalyzeDocument` with `FeatureTypes=[TABLES, LAYOUT]` is the relevant call.
- **Pricing:** **First 1M pages/month = $0.015/pg; over 1M = $0.010/pg** for tables+layout. **Layout is free when used with the Tables feature**, so the effective rate for tables+layout is $0.015/pg.
- **Output:** **JSON Blocks only — no native markdown.** Structure is a `Blocks` array of typed blocks (`TABLE`, `CELL`, `MERGED_CELL`, `TABLE_TITLE`, `LAYOUT_TITLE`, `LAYOUT_HEADER`, `LAYOUT_SECTION_HEADER`, `LAYOUT_LIST`, `LAYOUT_TABLE`, `LAYOUT_KEY_VALUE`, …). **You must write a Block→markdown converter** (or use a community library).
- **Quality on multi-column research tables:** Mature table + layout extraction; handles merged cells, titles, footers. PDFbench included Textract among the 4 commercial APIs. Reliable but output-shape friction.
- **Latency:** Async; seconds-to-tens-of-seconds; scales well.
- **Python SDK:** `boto3` (official, first-class) — strongest SDK story given the AWS stack.
- **Privacy/data handling:** ⚠️ **Weakest of the hyperscalers by default.** Textract **may store and use document/image inputs to improve Textract and other AWS ML/AI technologies**; unless you opt out, "some portion" of processed content **may be stored in another AWS Region** for improvement. You retain ownership; opt out via AWS Organizations AI services opt-out policy; can request deletion via AWS Support. Custom Queries adapter training content is in-region and deleted post-training. **Action: enable the AI services opt-out policy if WRI uses Textract.**
- **Fit for WRI:** Tenancy affinity with Fargate/RDS is attractive, and `boto3` is already familiar. But the JSON-only output (write+maintain a converter) and the improvement-training default are real drawbacks vs LlamaParse's native markdown. Reasonable as a second-tier/scale option, not the primary.

### 6. Mathpix — **Best for equation/science-heavy reports**
- **What:** Mathpix's PDF-to-markdown `v3/pdf` Convert API; lineage in math/science OCR (Snip).
- **Pricing:** **$0.005/pg for 0–1M pages/month; $0.0035/pg over 1M**; **$19.99 one-time setup fee** on pay-as-you-go.
- **Output:** **Markdown**, including LaTeX-quality **tables** and equations; also Mathpix Markdown (MMD) flavor.
- **Quality on multi-column research tables:** Excellent on equations and tabular scientific content — its specialty. Strong on the equation/notation that breaks other parsers (the academic-paper failure mode PDFbench flagged).
- **Latency:** Async; seconds-to-minutes per document.
- **Python SDK:** Official `mathpix` Python SDK + REST.
- **Privacy/data handling:** Documented but lighter enterprise posture than the hyperscalers; confirm data residency/retention directly for any pre-publication WRI drafts.
- **Fit for WRI:** Niche-fit for WRI's more technical/scientific reports with equations or dense data tables. Worth a benchmark on a sample of hard WRI reports. Not the general default (LlamaParse covers the same ground more cheaply for non-equation content).

### 7. Mistral OCR (2025 emerging) — **Cheapest; worth a cheap experiment**
- **What:** Mistral's document OCR endpoint, returns markdown with multi-column and table support.
- **Pricing:** **$0.001/pg standard; ~$0.0005/pg in batch mode** ("approximately double the pages per dollar").
- **Output:** **Markdown** with `table_format=markdown` (or `html`); handles multi-column text and tables.
- **Quality on multi-column research tables:** Promising on multi-column per docs; less independently benchmarked than the others. Newer entrant — treat as experimental until validated on WRI's actual reports.
- **Latency:** Fast (LLM-grade inference).
- **Python SDK:** `mistralai` Python SDK.
- **Privacy/data handling:** Mistral cloud; standard Mistral data terms — confirm for pre-publication drafts.
- **Fit for WRI:** Best $/page by a wide margin and native markdown output. Cheapest credible option to A/B test against LlamaParse on a WRI sample. Not yet a safe production default given recency.

---

## LlamaParse vs current `PDFReader` — the upgrade tradeoff

| Dimension | Current `PDFReader` (pypdf) | LlamaParse |
|---|---|---|
| Text layer (born-digital) | ✅ | ✅ |
| Layout / reading order | ❌ | ✅ |
| Tables | ❌ (flattened) | ✅ (markdown tables, cell bbox) |
| OCR (scanned reports) | ❌ | ✅ |
| Multi-column handling | ❌ (often interleaves) | ✅ |
| Output format | Plain text | Markdown + JSON |
| Cost | Free | ~$0.003/pg (1k pg/mo free) |
| Data egress | None (local) | Cloud (VPC option for enterprise) |
| Integration glue | None | Minimal (same LlamaIndex reader interface) |
| Latency | Instant (local) | Seconds/page (cloud) |

**Recommendation:** Replace `PDFReader` with the LlamaParse reader as the *default* parser in the ingestion worker. Keep a local parser (sibling agent's pick) as a *cheap tier* for easy born-digital text-only PDFs, and route scanned + table-heavy + multi-column reports to LlamaParse. This mirrors the PDFbench decision framework ("portfolio decision" — route by document class).

**Vs a pure local-parser approach:** Local parsers win on privacy, cost-at-scale, and offline determinism; LlamaParse wins on complex-layout + OCR fidelity and zero ops. For WRI's mix of scanned + multi-column + table-heavy research reports, a local-only stack will systematically underperform on the hardest 30–50% of the corpus (the academic-paper failure mode). The hybrid (local cheap-tier + LlamaParse hard-tier) captures most of the value at controlled cost.

---

## Evidence links

### Pricing pages (primary)
- **LlamaParse / LlamaIndex:** https://www.llamaindex.ai/ (credit model; free 10k credits/mo) · API ref: https://developers.api.llamaindex.ai/api/python/resources/parsing/methods/create/ (tier names: fast/cost_effective/agentic/agentic_plus) · extraction credits: https://developers.api.llamaindex.ai/api/python/resources/configurations/methods/retrieve/ (5 & 15 credits/pg)
- **Adobe PDF Extract:** https://developer.adobe.com/document-services/pricing/main (500 free tx/mo; paid contact sales) · licensing/5-page rounding: https://developer.adobe.com/document-services/docs/overview/pdf-extract-api/dcserviceslicensing
- **Mathpix:** https://website.mathpix.com/pricing/api ($0.005/pg 0–1M; $0.0035/pg 1M+; $19.99 setup)
- **Google Document AI:** https://cloud.google.com/document-ai/pricing (OCR $1.50/1k pg; Layout $10/1k pg; Splitter $5/1k pg)
- **Azure AI Document Intelligence:** https://azure.microsoft.com/en-us/pricing/details/ai-document-intelligence/ (Layout/prebuilt $10/1k pg; 500 pg/mo free)
- **AWS Textract:** https://aws.amazon.com/textract/pricing/ ($0.015/pg first 1M; $0.010/pg over; layout free w/ tables)
- **Mistral OCR:** https://mistral.ai/pricing/ ($1/1k pg = $0.001/pg; batch ≈ half) · announcement: https://mistral.ai/news/mistral-ocr/

### Output format / docs
- **LlamaParse:** https://pypi.org/project/llama-parse/ (Python SDK; table recognition) · https://ts.llamaindex.ai/docs/llamaindex/modules/data/readers/llama_parse (reader interface) · cell-level bbox (secondary): https://genaipm.com/wiki/tools/llamaparse
- **Adobe PDF Extract:** https://developer.adobe.com/document-services/docs/overview/pdf-extract-api/gettingstarted (JSON output) · https://developer.adobe.com/document-services/docs/overview/pdf-extract-api/howtos/pdf-to-markdown-api (markdown how-to) · technical brief: https://developer.adobe.com/document-services/docs/assets/268b4618cd5696a95ebf8cc01de5f310/Adobe_PDF_Extract_API_Technical_Brief.pdf
- **Google Document AI:** https://docs.cloud.google.com/document-ai/docs/layout-parse-quickstart (Layout Parser quickstart) · output: https://docs.cloud.google.com/document-ai/docs/output · `Document` schema: https://docs.cloud.google.com/document-ai/docs/reference/rest/v1/Document · regions: https://docs.cloud.google.com/document-ai/docs/regions
- **Azure Document Intelligence:** model overview: https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/model-overview?view=doc-intel-4.0.0 (Layout → markdown) · privacy/security: https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/document-intelligence/data-privacy-security · customer-managed keys: https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/authentication/encrypt-data-at-rest?view=doc-intel-4.0.0
- **AWS Textract:** AnalyzeDocument API: https://docs.aws.amazon.com/textract/latest/APIReference/API_AnalyzeDocument.html (JSON Blocks; FeatureTypes) · tables: https://docs.aws.amazon.com/textract/latest/dg/how-it-works-tables.html · layout response: https://docs.aws.amazon.com/textract/latest/dg/layoutresponse.html · data protection: https://docs.aws.amazon.com/textract/latest/dg/data-protection.html · FAQ (opt-out): https://aws.amazon.com/textract/faqs/
- **Mathpix:** https://docs.mathpix.com/ · https://mathpix.com/pdf-to-markdown · https://mathpix.com/table-to-markdown
- **Mistral OCR:** https://docs.mistral.ai/studio-api/document-processing/basic_ocr (table_format=markdown) · endpoint: https://docs.mistral.ai/api/endpoint/ocr

### Benchmarks / comparisons
- **PDFbench (Applied AI, 2026)** — 17 parsers on 800+ docs; LlamaParse = quality/cost "sweet spot" (78% edit sim, 81% ChrF++, 39% tree sim, $0.003/pg); academic papers hardest (best 60%); domain gap 55pts: https://www.applied-ai.com/briefings/pdf-parsing-benchmark/
- **ParseBench (2026)** — "Try LlamaParse—#1 on ParseBench": https://www.parsebench.ai/ · arXiv: https://arxiv.org/abs/2604.08538
- **Academic-PDF table benchmark** — Adobe Extract outperforms others on table extraction: https://arxiv.org/abs/2303.09957

### Sources — kept vs dropped
- **Kept:** PDFbench (Applied AI) — primary independent benchmark covering all 4 target commercial APIs; official pricing pages for each API; official docs for output format & privacy; Adobe technical brief; ParseBench.
- **Dropped:** Reddit threads (anecdotal), `apis.io`/`apiscout`/`aitoolsatlas`/`aidemos` pricing-summary pages (SEO aggregators — used only to corroborate the credit→USD conversion, flagged as non-authoritative), localized Azure pricing mirrors, Adobe marketing PDFs unrelated to Extract API.

---

## Gaps (and suggested next steps)
1. **LlamaParse USD price card** is not published on LlamaIndex's own site (credit-based only). The $0.003/page figure is from PDFbench; the $0.00125/credit conversion is third-party. **Next step:** request the paid price sheet / credit-to-USD conversion from LlamaIndex sales; validate against a real invoice.
2. **Adobe PDF Extract paid $/transaction** is contact-sales only. **Next step:** get a quote for WRI's expected monthly page volume and compute effective $/page against the 5-page-rounding billing.
3. **LlamaParse retention period** is not publicly disclosed. **Next step:** confirm in an enterprise agreement (esp. for pre-publication WRI drafts).
4. **Per-domain benchmark scores** for Azure / Google / Textract on academic-style reports specifically were not fully broken out in the surfaced PDFbench snippet. **Next step:** run a 20–30-doc WRI sample through LlamaParse + Adobe + Azure + Mathpix + Mistral OCR and score with edit-sim / tree-sim / TEDS to confirm the ranking on *WRI's actual* reports.
5. **Mistral OCR independent benchmarking** is thin. **Next step:** include it in the WRI sample A/B given its low cost.

---

## Confidence
- **High:** LlamaParse as the best quality/cost cloud fit for WRI (native LlamaIndex fit + PDFbench "sweet spot" + OCR/tables/layout + free tier); Adobe's privacy posture (24h retention, per-transaction US/EU); Google/Azure/AWS per-page pricing and output formats; Mathpix pricing; Mistral OCR pricing + markdown output.
- **Medium:** LlamaParse's exact USD $/page (credit model, third-party conversion); Adobe's effective paid $/page (contact sales); exact per-domain fidelity of Azure/Google/Textract on academic-style reports.
- **Low:** Mistral OCR's real-world fidelity on WRI-class reports (new entrant, little independent benchmarking).

---
*Research lane brief produced 2026-07-02 by the `researcher` subagent (web-sourced). Subagent coordination trailers trimmed for the team commit.*
