# Document Understanding & Extraction — Scientific Papers

**Date:** 2026-06-09
**Status:** Approach for the highest-leverage doc-management gap
**Scope:** Ingestion-side extraction only (doc management). Retrieval tuning is a separate workstream.
**Context:** Corpus is mostly **scientific papers, figure- and table-heavy.**

## Why this is the friendly case

Arbitrary PDFs are hard because they have no structure. Scientific papers do: title, authors, abstract, numbered sections, captioned figures, captioned tables, and a reference list — in a small number of predictable layouts (single/two-column, journal or working-paper templates). That structure is **machine-parsable**, which means we can extract rich metadata reliably *and* turn the figure/table problem into a tractable one. The risk is not "can we parse it" but "do we preserve the tables, because that's where the answers are."

The governing fact from the research: **retrieval quality is capped by extraction quality** — poor parsing/segmentation directly degrades downstream answers ([LandingAI](https://landing.ai/llms/document-extraction-for-rag-preparing-structured-outputs-for-vector-databases)). So this stage is worth getting right before schema freeze.

## The approach: two-stage parse, tables/figures as first-class units

**Stage 1 — Scholarly structure + metadata (GROBID).** GROBID is purpose-built for scholarly PDFs and deterministically extracts front matter (title, authors, abstract, DOI, journal), the section hierarchy, figure/table captions, and the reference list as structured TEI ([GROBID vs Docling](https://github.com/docling-project/docling/discussions/622)). This directly feeds:
- the **metadata store** (title, authors, abstract → summary seed, DOI, publication),
- **identity & lifecycle** — DOI is the natural dedup/versioning key, and enables cross-lingual variant detection (same DOI/title, different language),
- a future **citation graph** (references), noted but out of scope now.
It's open-source, fast, and cheap, and it does the metadata job better than a general VLM.

**Stage 2 — Layout + table/figure extraction.** A layout-aware parser converts the body to structured Markdown/JSON with **tables reconstructed (HTML, colspan/rowspan), figures with captions and bounding boxes, and page numbers** ([best practice](https://www.llamaindex.ai/insights/ocr-to-markdown-evaluation), [Docling vs Marker vs LlamaParse](https://codecut.ai/docling-vs-marker-vs-llamaparse/)). Candidates to bench on real WRI papers:
- **Docling** (IBM, open) — strong layout + built-in chunking, but *can hallucinate values on dense tables* → quality gate required.
- **Marker** (open, local, fast) — 5-stage specialist-model pipeline; good when staying local.
- **LlamaParse** (hosted, top accuracy) — now permissible since governance cleared third-party APIs.

**Tables and figures become discrete retrieval units, not flattened text.** This is the crux for "the answer is in Table 3":
- **Each table → its own chunk** = caption + structured table (Markdown/HTML) + a short LLM-generated summary, with **context enrichment** (concatenate column headers with values so a row is self-describing) ([practice](https://landing.ai/llms/document-extraction-for-rag-preparing-structured-outputs-for-vector-databases)).
- **Each figure → its own chunk** = caption + optional VLM-generated description.
- Both carry metadata: `unit_type` (table/figure/text), number, page, parent section, parent document.

**Body text → structure-aware chunking.** Chunk on section boundaries, keep the abstract whole, attach the section path + page to every chunk, and **never split a table across chunks**. This preserves citation precision and keeps tabular data intact.

## Quality gate + review queue (the doc-management surface)

Because layout/VLM parsers can hallucinate table cells and because scanned or oddly-typeset papers break, the ingestion worker scores **extraction confidence** per document and routes failures to a human review queue in the admin UI. Cheap, effective signals:
- GROBID found title + abstract + ≥N sections?
- Tables returned well-formed (consistent column counts, no empty grids)?
- Text density per page within a sane range (catches image-only / OCR-garbage pages)?
- Detected language consistent across the document?

Low-confidence docs are ingested as `needs_review` rather than silently polluting the corpus. This is the concrete answer to "how do we handle the broken-PDF tail."

## How tables/figures land in the schema

Extends `document_chunks` from the redesign doc with a unit type and structured payload:
```
document_chunks
  ... (existing: id, document_id, chunk_index, page, text, embedding, sparse, tsv)
  unit_type        -- text | table | figure
  unit_number      -- e.g. "Table 3", "Figure 2"
  section_path     -- e.g. "3.2 Results > Emissions"
  caption
  structured       -- jsonb: table as HTML/markdown + parsed cells; figure descriptor
```
Tables/figures embed from caption + summary + linearized cells, so they retrieve on the data they contain while the structured payload is preserved for display and verification.

## The spike (do this before freezing schema)

Run the candidate parsers (Docling, Marker, LlamaParse) on a **representative sample of real WRI papers** — include a two-column journal article, a long working paper, a table-dense report, and one known-bad/scanned PDF. Score on:
- table fidelity (cells correct, structure preserved, no hallucinated numbers),
- figure caption capture,
- metadata completeness (title/authors/abstract/DOI),
- section segmentation,
- failure detection (does our confidence gate flag the bad one?).

Output: a parser choice (or hosted/local split) and a calibrated confidence gate. Then freeze `document_chunks`.

## Open questions specific to extraction

1. Are equation-heavy papers common enough to need VLM/Nougat-style formula handling, or are these mostly applied/policy papers where tables matter more than math?
2. Hosted (LlamaParse, best accuracy) vs. local (Marker/Docling) for the table parser — decide on spike results and cost.
3. Should the original PDF page image be retained per table/figure for display/verification in the admin UI? (Recommend yes — store in S3.)

## Sources

[Best PDF parsers 2026 (Firecrawl)](https://www.firecrawl.dev/blog/best-pdf-parsers), [Docling vs Marker vs LlamaParse](https://codecut.ai/docling-vs-marker-vs-llamaparse/), [GROBID vs Docling](https://github.com/docling-project/docling/discussions/622), [OCR-to-Markdown evaluation (LlamaIndex)](https://www.llamaindex.ai/insights/ocr-to-markdown-evaluation), [Document extraction for RAG (LandingAI)](https://landing.ai/llms/document-extraction-for-rag-preparing-structured-outputs-for-vector-databases), [Text-and-Table RAG benchmark](https://arxiv.org/pdf/2506.12071).
