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

## Recommendation

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
