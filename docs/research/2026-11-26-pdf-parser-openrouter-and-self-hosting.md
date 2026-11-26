# Research: PDF parser candidates on OpenRouter, a hard-page stress test, and self-hosting as a deferred option

**Date:** 2026-11-26. **Builds on:** the 24 November parser comparison (summary in
`docs/runbooks/pdf-parser-migration.md`; outputs in `evaluation/results/parser-comparison-2026-11-24/`,
not committed). **Full report:** second edition of the private parser-evaluation site, with every
output, raw response and source page. **Tooling:** `evaluation/parser-eval/`.

## Decision

> **Superseded later the same day by §7.** The follow-up measurements below changed this
> recommendation to **Sonnet 5.5 alone**, and to replacing Mistral: across the whole hard set Mistral
> keeps 77.1% of numbers, on ordinary pages Inkling keeps 98.9% against Sonnet's 99.9% while a full
> rebuild costs only ~$160 more with Sonnet, and the number check flags a third of pages even at 99.9%
> accuracy, so it cannot be the cheap option's safety net. The bullets below are kept as the second
> edition's record; read §7 before acting on them.

- **Pilot Sonnet 5.5 through OpenRouter, on WRI's own account.** On 27 hard pages it kept the same
  numbers as GPT-6.2 Astra (99.8%, every language) at about a quarter of Astra's billed cost, and
  finished fastest. WRI has OpenRouter access, which would route around the Bedrock `InvokeModel`
  denial on the QA task role. These runs used a personal OpenRouter key; WRI's account has not been
  exercised yet.
- **Pilot Inkling 2 Mini with the number check as the low-cost option.** It nearly matched the leaders
  (96/96 reference cells, 98.5% of numbers on the hard pages, level with Gemini 3.8 Flash) at $1.37
  per 1,000 pages, about a seventeenth of Sonnet and a tenth of Flash, and it is the only open-weight
  (Apache-2.0) model here, so the one with a self-hosting path. Its errors are misread digits in very
  dense tables (11 of about 585 values on one page), which the text-layer number check catches
  because the wrong value is not on the page. It takes images only, so pages must be rendered (3x).
- **Gemini 3.8 Flash is the middle option**: similar accuracy at $13 per 1,000 pages, native PDF
  input, and its misses are omissions (list numbers, axis ticks) rather than misreads.
- **Replace Mistral OCR.** It drops decimal points and chart values: 84% of numbers kept on the hard
  pages, 73% on Chinese.
- **Pair whichever model with a number check** against the page's PDF text layer (below).
- **Self-hosting an open-weight OCR model is not pursued now** (section "Self-hosting").

This is a pilot recommendation, not a rollout: references are agent-reviewed, runs are single, and no
retrieval experiment has run.

## 1. What was tested

Three evaluations, all with the first edition's transcription prompt verbatim, one page per call:

| Evaluation | Pages | Scored by |
|---|---|---|
| 103-page pass (24 Nov) | 6 whole papers | page coverage |
| Eight reference pages | EN 2, ZH 2, ES 2, PT 2 | the first edition's frozen references: 20 prose regions (5,600 chars) and 96 table/figure cells, scored with the v2 scorer, plus conversion of HTML tables to pipe rows for candidates that write HTML. Re-scoring the original five candidates reproduced every published number before the new ones were scored |
| 27 hard pages (new) | ZH 8, ES 7, PT 5, ID 2, EN 5 | each page's own text layer (section 3) |

The hard pages were chosen by profiling all 9,292 pages of the 169 local PDFs (`search-service/data/`)
for dense numeric tables, charts, footnotes, landscape layouts and damaged text layers, then taking the
hardest per language, at most two per document, none from the first edition.

Routes added: `anthropic/claude-sonnet-5.5`, `openai/gpt-6.2-astra`, `google/gemini-3.8-flash`,
`google/gemini-4-hydrogen` with native PDF input; `thinkingmachines/inkling-2-mini` with PNG at 3x
(image-only model); Mistral OCR via OpenRouter's file-parser engine; Docling 2.152.0 locally.

## 2. Results

### Eight reference pages (first-edition method)

| Variant | Prose edits / 5,600 | Cells / 96 |
|---|---|---|
| Mistral OCR (direct, 24 Nov) | 2 | 54 |
| GPT-6.2 Astra (24 Nov) | 0 | 96 |
| Sonnet 5.5, Claude Code (24 Nov) | 0 | 96 |
| Docling (24 Nov) | 544 | 60 |
| Sonnet 5.5, OpenRouter | 0 | 80 |
| Gemini 3.8 Flash | 0 | 96 |
| Gemini 4 Hydrogen | 0 | 96 |
| Inkling 2 Mini, 3x image | 3 | 96 |

Sonnet's 80/96 is one Portuguese figure: it wrote all 16 city names as a flat list instead of a
four-column table, so group membership is only implied by position. The same model kept the table
through Claude Code. Output format varies between runs; a prompt or validation rule should handle it.

### 27 hard pages (share of printed numbers kept, 23 scorable pages)

| Variant | All | ZH | ES | PT | ID | EN | Billed per 1,000 pages |
|---|---|---|---|---|---|---|---|
| Sonnet 5.5 | 99.8% | 100 | 100 | 100 | 97.5 | 100 | $23 |
| GPT-6.2 Astra (default reasoning) | 99.8% | 100 | 100 | 100 | 97.5 | 100 | $89 |
| Gemini 4 Hydrogen | 99.8% | 100 | 100 | 100 | 97.5 | 100 | $32 |
| Inkling 2 Mini (3x image) | 98.5% | 99.9 | 96.9 | 97.5 | 97.5 | 100 | $1.37 |
| Gemini 3.8 Flash | 98.4% | 97.9 | 97.6 | 100 | 97.5 | 100 | $13 |
| Mistral OCR | 83.9% | 73.1 | 86.6 | 83.0 | 97.5 | 99.7 | $2.01 |
| Docling (local) | 82.1% | 72.9 | 89.3 | 69.6 | 95.9 | 99.4 | unpriced |

Billed rates come from these dense pages and lean high; on the eight lighter reference pages Sonnet
billed $13.93, Gemini 3.8 Flash $7.71 and Inkling 2 Mini $1.07 per 1,000 pages.

### Confirmed defects (checked against the text layer)

- **Mistral:** decimal points dropped (4.5-ton trucks became 45-ton; 6~7.5 became 6~75), a garbled
  Spanish materials table, charts replaced by image placeholders.
- **Inkling 2 Mini:** digit errors in a nine-decimal table (11 of about 585 values, e.g. 0.61482128
  written as 0.61492128). At 1.5x page images it had misread a Chinese rate as 29% instead of 2.9%;
  3x fixed most of that.
- **Gemini 3.8 Flash:** rebuilt bar charts as tables with correct values but generic column labels;
  copies wide visual layouts as one wide table.
- **Sonnet, Astra, Hydrogen:** no invented numbers; every extra number traced to formatting (HTML
  attributes, subscripts, page numbers, scale bars, axis ticks).

## 3. The text layer: reference and production guard

The corpus is born-digital: 94% of pages (8,695 of 9,292) carry a real text layer, 341 are image-only
(apparently photos and dividers), 20 pages in 7 documents have a damaged layer. A text layer records
exactly which characters are printed, for free, but not reading order or table structure.

Two consequences:

- **It can hold invisible text.** 3 of the 27 hard pages do, one a whole spreadsheet (about 15,700
  characters) under two screenshots of it. Every model correctly transcribed only the visible page.
  Docling, which reads the layer, picked some of it up; the current pypdf fallback would index all
  of it.
- **It makes a cheap guard.** Check that every number a model writes exists in the page's text layer,
  and flag or re-run the page when one does not. Only in that direction: the reverse fails on hidden
  text. Skip pages whose layer is damaged. The scorer in `evaluation/parser-eval/score_text_layer.py`
  is the prototype. **Superseded in part by §7.3:** measured on ordinary pages, this rule flags a
  third of a 99.9%-accurate model's pages (figure numbers, callouts, page numbers) and cannot see the
  omissions that make up the cheap model's remaining errors.

## 4. What the OpenRouter route changes

- Through WRI's OpenRouter access, Sonnet would be reachable without a Bedrock IAM change. Astra is
  also listed there. All runs here used a personal key; moving to WRI's account means a WRI key and a
  first small run to confirm access and billing.
- OpenRouter forwards each page to the underlying provider. The corpus is published WRI material, but
  confirm WRI's account data policy (provider routing, logging, retention) before a full run.
- `mistral-ocr` on OpenRouter is a file-parser engine ($2 per 1,000 pages), not a model; its
  transcription comes back as an annotation.
- Not on OpenRouter: the dedicated open OCR models (PaddleOCR-VL, dots.ocr / dots.mocr, MinerU,
  Chandra, GLM-OCR, olmOCR). Hugging Face Inference Providers serve none of them either (checked
  2026-11-26).

## 5. Self-hosting: documented option, not pursued now

### Why it is deferred

- The ingestion worker runs on ECS Fargate, which has no GPUs; every competitive open OCR model is a
  vision-language model that wants one for corpus-scale throughput.
- Hosting means new infrastructure, a runtime to patch and monitor, and model-revision pinning for the
  parse cache, for a stage that runs once per document.
- API models already reach the ceiling of what these checks can measure, at modest cost.

### Candidates if revisited

Scores are model-card and leaderboard figures, not WRI results.

| Model | Size | Languages | Published evidence | Licence |
|---|---|---|---|---|
| PaddleOCR-VL-1.6 | 0.9B | 109 | 96.34 on OmniDocBench v1.6 | Apache-2.0 |
| MinerU2.5-Pro (VLM mode) | 1.2B | 109 | 95.75 on OmniDocBench v1.6 | Apache-2.0-based, extra commercial terms |
| GLM-OCR | 0.9B | 8, no Portuguese | 95.22 on OmniDocBench v1.6 | MIT |
| dots.mocr / dots.ocr | 3B | 100+ | best on Latin scripts in the MORE benchmark | MIT with extra terms |
| Chandra OCR 2 | — | 90+ | 79.7 on MDPBench | modified OpenRAIL-M |
| Inkling 2 Mini | 26.4B total, 3.4B active | not stated | 98.5% of numbers on the hard pages (this study, via API) | Apache-2.0 |

Not suitable: olmOCR-2 (English only). None is gated on Hugging Face.

### Hosting routes, cheapest to operate first

1. **Batch job, not a service:** a GPU job (AWS Batch or ECS on EC2) that parses a manifest into the
   parse cache during a rebuild, then shuts down.
2. **Managed endpoint** (SageMaker, Hugging Face Inference Endpoints) with scale-to-zero.
3. **Third-party inference host:** least work, another data processor.
4. **Always-on GPU service in the cluster:** hardest to justify.

### What adoption would take

A parser adapter in `search-service/worker/stages/parse.py` (today only `mistral` is dispatched), a
cache identity that includes the exact model revision, and the full procedure in
`docs/runbooks/pdf-parser-migration.md`.

### When to revisit

An open model matches the API leaders on the reference and hard pages, **and** API spend for full
rebuilds becomes material or WRI needs documents kept inside its own AWS account. Inkling 2 Mini's
result suggests a small open model could get close; a local trial on a 32 GB Apple Silicon laptop is
enough to test the first condition.

## 6. Limits

Agent-reviewed references, not independent human ground truth. Single runs. The hard-page scorer
measures numbers and words, not reading order or cell placement. Astra on OpenRouter ran with default
reasoning, not the first edition's high setting. No full-corpus run, no cross-page table continuity,
no controlled retrieval experiment. No QA index, queue, IAM or serving configuration changed.

## 7. Follow-up, later on 26 November: ordinary pages, the whole hard set, and the revised recommendation

Two measurements made after the second edition was published, both cheap enough to run before
acting on it. They are published as a follow-on eval section in the revised report
(`AskWRI-parser-report-v4.pdf` on the private report site); the second edition (`v3`) remains the
record of what was measured before them.

### 7.1 Mistral over the whole hard-document set (no API calls)

The current parser's output needed no re-run: QA stores it. All 24 hard documents — 1,947 pages —
were scored against each page's own text layer by splitting QA's `document_texts` at its page
boundaries (`score_qa_text.py`). Twelve pages with damaged layers were excluded; 1,519 pages carry
at least five numbers (68,584 numbers).

| Measure | Value |
|---|---|
| Numbers kept, token-weighted | **77.1%** |
| Mean per-page keeping | 83.3% |
| Pages keeping 100% | 58.1% |
| Pages keeping under 50% | 15.3% |
| Pages with any extra number | 61.7% |

By language: zh 68.5%, en 71.1%, es 86.8%, pt 87.6%, id 92.2%.

The losses are chart pages. Mistral writes `![img-N.jpeg]` where a chart sits, and the chart's axis
and data labels are vector text in the layer. Confirmed by eye on 4687 p13 (2% of 62 numbers kept),
7600 p56, 2276 p18, 6748 p18 and p58. The hard-page table's 83.9% was directionally right; measured
over whole documents the loss is larger and concentrated on those pages.

### 7.2 One hundred ordinary pages, three parsers ($1.97)

`pick_ordinary_pages.py` samples content pages seeded, one or two per document, excluding the pages
the hard set already covers: en 59, zh 20, es 15, pt 4, id 2, from 51 documents. The exact sample is
committed as `evaluation/parser-eval/ordinary-100-selection.json`; `pick_ordinary_pages.py --check`
asserts its 100 pages, 51 documents, per-language counts and absence of duplicate pages. `build_set.py`
builds them (its optional selection argument), `run_openrouter.py` parses them, and Mistral's stored
text is scored on the same pages. Per model, over the 87 pages that carry at least five numbers:

| Parser | Numbers kept (token) | Pages under 100% | of those, no extra number (check silent) | Pages with an extra number | $/1,000 pages | s/page |
|---|---|---|---|---|---|---|
| Sonnet 5.5 | 99.89% | 1 / 87 | 0 | 34% | $18.52 | 7.2 |
| Inkling 2 Mini | 98.87% | 11 / 87 | 5 | 26% | $1.20 | 12.5 |
| Mistral OCR (stored) | 85.49% | 28 / 85 | 4 | 60% | ~$2 | — |

By language (numbers kept): Sonnet en 99.78 / zh 100 / es 100 / id 100 / pt 100; Inkling en 98.54 /
zh 98.82 / es 99.68 / id 96.97 / pt 100; Mistral en 85.83 / zh 74.96 / es 95.87 / id 84.85 / pt 100.

Inkling's weak pages: 3356 p21 55.3% (flagged), 6429 p7 85.7% (flagged), 7471 p40 90.0% (silent),
4324 p7 90.9% (flagged), 8038 p111 91.7% (flagged), 1665 p10 92.3% (silent), 2716 p11 92.9%
(flagged), 1735 p34 95.2% (flagged), 1267 p51 95.7% (silent), 7051 p73 98.1% (silent), 1735 p21
98.1% (silent).

### 7.3 What the number check can and cannot do

Section 3 proposed the guard as "every number the model writes exists in the page's text layer". On
ordinary pages that rule flags **34% of Sonnet's pages while Sonnet keeps 99.9% of numbers** —
figure numbers, numbered callouts and page numbers, not errors. It flagged 26% of Inkling's pages and
60% of Mistral's. It caught 6 of Inkling's 11 weak pages; the other 5 fail by omitting numbers, and
an omission produces no extra number to catch. Priced as a production guard with Sonnet as the
fallback, Inkling costs $1.20 + 0.26 × $18.52 ≈ $6.00 per 1,000 pages, about $56 per full rebuild.

So the check cannot be the cheap option's safety net, and the rule as prototyped is too loose to
ship. A pipeline stage would need a narrower rule — an extra number one edit away from a printed one,
which is what a misread digit looks like — and would still be blind to omissions.

### 7.4 Revised recommendation

- **Replace Mistral OCR with Sonnet 5.5.** It keeps 99.9% of numbers on ordinary pages and 100% in
  four of five languages, against Mistral's 85.5% on the same pages and 77.1% over the hard set.
- **Do not adopt Inkling 2 Mini as the default.** It trails Sonnet by 1.0 point on ordinary pages and
  1.3 on the hard set, and the check does not close the gap because it cannot see omissions.
- **Do not build the number check into the pipeline yet.** If it is revisited, start from the
  near-miss rule above and measure its false-positive rate first.
- **Cost is not the deciding factor at this corpus size.** A full 9,292-page rebuild costs ~$172 with
  Sonnet, ~$11 with Inkling, ~$56 for the pair and ~$19 today: a ~$160 one-off difference.
- **WRI's OpenRouter account is still unexercised.** Every run in this document and in this section
  used the personal key; a WRI-account run against the data policy is still owed before a migration.

### 7.5 Limits of this follow-up

One run per model; 100 ordinary pages from 51 documents; agent-reviewed, like the rest of the
evaluation. It measures numbers and words, not reading order or table cells, and says nothing about
retrieval or answers. The hard-set sweep compares QA's stored text with the local PDFs' layers; the
`content_hash` of all 24 documents matched the local bytes, twelve damaged layers were excluded, and
the known invisible-text pages were confirmed by eye, but hidden text can still inflate the
denominator. The report PDF was revised in place as `v4`, keeping the second edition's content and
adding this follow-up as its own section; `v3` remains published for comparison. The report, its
scores and its cost records live on the private site under `evidence/v4`; the scripts that produced
them are in `evaluation/parser-eval/`.

## Sources

- OpenRouter model list and PDF engines: https://openrouter.ai/api/v1/models, https://openrouter.ai/docs/features/multimodal/pdfs (read 2026-11-26)
- Thinking Machines, Inkling 2 Mini: https://thinkingmachines.ai/news/inkling-2-mini/
- Roboflow, open-source OCR models on OmniDocBench v1.6: https://roboflow.com/blog/best-open-source-ocr-models
- Hugging Face, open OCR models: https://huggingface.co/blog/ocr-open-models
- MDPBench: https://arxiv.org/pdf/2603.28130
- MORE multilingual benchmark: https://arxiv.org/html/2607.02956v1
