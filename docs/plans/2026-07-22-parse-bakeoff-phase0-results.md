# Parse Bake-off — Phase 0 Results (parse quality, direct)

**Date:** 2026-07-22 · **Plan:** `2026-07-02-pdf-parsing-bakeoff-plan.md` §5, shortlist updated per `2026-07-22-multilingual-v3-todos.md`
**Fixture:** 14 WRI PDFs (~479 pages), stratified en/zh/es/pt — `evaluation/fixtures/parse-bakeoff-manifest.json`
**Harness:** `search-service/scripts/parse_fixture.py` + `score_parse_fixture.py`; raw outputs in `evaluation/results/parse-fixture-<backend>.json` (untracked, regenerable)
**Candidates:** pypdf (production baseline & oracle) · Mistral OCR (`mistral-ocr-latest`) · Gemini 3.1 Pro (`gemini-3.1-pro-preview`, whole-doc single call) · Bedrock Data Automation (LIVE project, DOCUMENT+PAGE+ELEMENT granularity, markdown)

Phase 0 is **advisory** (plan §5.3); the binding gate is the Phase 1 full-corpus
retrieval eval on whichever candidate advances.

## Headline metrics (vs pypdf oracle)

| | Mistral OCR | Gemini 3.1 Pro | BDA |
|---|---|---|---|
| Length ratio (typical) | 0.85–1.16 | **0.90–1.07** | 1.2–2.7 (caption duplication — see findings) |
| Numeric recall, clean dense docs | 91–98% | 94–100% | 88–100% |
| Markdown tables (state-table check) | ✅ 257 lines, all rows | ✅ 257 lines, all rows | ✅ 387 lines, all rows |
| Heading hierarchy incl. zh | ✅ | ✅ | ✅ |
| Multi-column reading order (spot-check) | ✅ clean | ✅ clean | ✅ clean |
| 152-page graphics manual (Zhuzhou) | ✅ all pages, +698 numeric tokens recovered | ❌ **truncated at 104pp** (0.64× text) | ✅ all pages, +8,190 tokens recovered |
| Wall clock per doc | **3–23s** | 38s–7min (≈10s/page) | 18–34s (~15s fixed queue overhead) |
| Est. full-corpus re-parse (~10.5k pages) | **~$10, well under 1h parallelized** | ~$100+, ~30h single-threaded + truncation engineering | ~$105, a few hours |

## Findings that reframe the raw numbers

1. **The pypdf oracle is itself defective in places.** The worst "recall"
   scores trace to pypdf emitting `/gid00017/gid00036/…` glyph-ID garbage
   (fonts without ToUnicode maps). Candidates were penalized for *not*
   reproducing garbage. **8 production documents (en 5 / es 2 / pt 1,
   ~2,600 `/gid` occurrences) carry this garbage in their live
   `document_texts` today** — a corpus-quality defect any candidate fixes.
2. **Remaining recall gaps are page furniture and chart internals**, not
   body content: per-page running footers, TOC dot-leader page numbers,
   and chart axis text that pypdf scrapes from embedded vector graphics.
   Furniture removal is arguably a *win* (footer noise pollutes chunks
   today). Chart-internal text is a genuine trade-off: candidates emit
   `![image]` placeholders where pypdf gets axis labels — but they also
   OCR rendered graphics pypdf can't (Zhuzhou/design-manual recovery).
3. **BDA duplicates figure captions per element** (one caption 68×),
   inflating output 1.2–2.7×. Usable, but production integration would
   need element-level dedup logic.
4. **Gemini's single-call mode truncates long documents** (104/152 and
   62/68 pages observed). A production integration would need page-batch
   orchestration — additional engineering the other two don't need — and
   at ≈10s/page it is by far the slowest and roughly the most expensive.

## Recommendation — **RATIFIED 2026-07-22 (dgutelius): Mistral OCR is the Phase C parser**

The spec (§7) carries a dated amendment pointing here; "Gemini parse"
throughout the v3 spec now reads "Mistral OCR parse". The Mistral egress
consideration below was accepted (published public corpus).

**Advance Mistral OCR to Phase 1** (full-corpus, eval-gated, `PARSE_BACKend=mistral`
behind the plan §6.1 flag): quality parity with Gemini on body text, equal
best-in-class structure (tables/headings incl. zh), no truncation, complete
coverage of the graphics-heavy hard case, ~10× cheaper and ~5× faster than
both alternatives at corpus scale.

**Keep BDA as the AWS-boundary fallback** (works today with the task-role
IAM story; revisit if Mistral's egress/vendor terms become a problem —
budget the dedup work). **Do not advance Gemini 3.1 Pro**: no quality edge
to pay for its truncation engineering, latency, and cost.

Egress note for the decision: Mistral OCR receives full document content
(as does Gemini; BDA stays in-account). WRI's corpus is published public
documents, so confidentiality exposure is minimal — but this is a vendor
decision the team should ratify explicitly.

## Phase 1 gate results (2026-07-22) — **PASS**

Full corpus re-parsed under `PARSE_BACKEND=mistral` (169/171 docs; 2
worker-uploaded docs' PDFs are missing from local MinIO — environmental,
not a parser issue; they keep their pypdf parse and searchable status,
see todos). Sparse lane rebuilt; cite floor re-derived on the new corpus
(0.10 → **0.09**, third derivation — the floor moves with every corpus
change, as designed).

| Gate criterion (plan §7) | Result |
|---|---|
| Cite recall ≥ baseline −2pp | **PASS** — R 83.1 vs 83.1 (exactly equal; floor chosen to hold it) |
| Answer within ±2pp | **PASS on doc-level** — F1 77.5 vs 75.6 (+1.9). Chunk-level invalid by construction: the golden set's chunk IDs reference pypdf chunk boundaries the re-parse replaced (redo already planned) |
| No non-English smoke regression | **PASS** — final 16/16, all tier=strong. Sub-signal: bm25-lane zh hits 11→9 (incidental Latin-token matches in zh docs; the English sparse lane is not a zh capability; dense 16/16 covers) |
| Scanned subset | N/A locally (no scanned docs in corpus) |
| Throughput/cost | PASS — parse ~3–23s/doc, ~$0.001/page |
| License/egress | Ratified 2026-07-22 |

Bonuses beyond the gate: cite precision +1.1 and **F1 43.2 — best
recorded**; the 8 glyph-garbage docs are cured (0 remaining); R4 (zh page
attribution) fixed structurally; corpus is 9% fewer chunks (28,181 vs
30,843) from cleaner text. Honest ledger: per-case pass count is 8/11 vs
baseline 9/11 (q10's low-scoring relevant docs sit near the floor;
q10/q11 remain the known fusion-miss + negation cases).

Incidents during the run (fixed + runbook'd): worker embed throttling
(needs adaptive retries + cross-region profile + `BEDROCK_EMBED_BATCH_SIZE=24`
+ ONE worker for bulk), two language-detection defects caught by the
before/after diff (bilingual covers; interleaved zh — both fixed with
tests), 2 docs with PDFs missing from local MinIO.

**Consequence: `PARSE_BACKEND=mistral` is cleared to become the default.
The local corpus is now Mistral-parsed** — the deployed cutover follows
`docs/runbooks/qa-deploy-multilingual-v3.md` Phase D.

## Phase 1 next steps (per plan §6, on sign-off)

1. `parse_backend` flag in config + `_parse_pdf` dispatch (`mistral`
   branch, per-page emission — also structurally fixes the R4 zh
   page-boundary bug) + tests.
2. `scripts/reingest_all.py`, full re-parse, sparse rebuild, then
   `run-baseline-suite.sh` under `parse-mistral` vs `parse-pypdf` labels.
3. Gate (plan §7): cite recall ≥ baseline −2pp, answer within ±2pp,
   no smoke regression, cost/throughput acceptable.
4. Cleanup after decision: BDA project `07aee510a362` + scratch bucket
   `askwri-parse-bakeoff-905418285725`.

Also fold in: the 8 glyph-garbage documents should be prioritized in any
re-parse regardless of parser choice.
