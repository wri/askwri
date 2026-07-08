# AskWRI Admin Guide

This guide explains the AskWRI document-management admin interface (`/admin`).

## Overview

AskWRI is a multilingual search engine over WRI's published corpus (transport
decarbonization). The admin interface lets you manage the document lifecycle:
ingest new PDFs, review flagged documents, edit metadata, manage tags and
collections, and monitor corpus health.

## Pages

### Review queue (`/admin/review`)

Documents that the ingestion pipeline flagged for human review (low extraction
confidence or worker errors) appear here. The corpus-health dashboard at the
top shows:

- **Worker status**: `idle` (caught up), `processing` (working), or `stale`
  (files in intake but not being processed — the worker may be down).
- **Counts by status and language**: how many docs are searchable/withdrawn,
  and the language distribution.
- **Missing renditions**: non-English documents that lack a native-language
  summary (design §7.5 requires native + English). Re-ingesting regenerates
  them.
- **Missing `title_en`**: non-English docs without an English title.
- **Low-confidence docs**: extraction confidence < 0.7.

**Actions:**
- **Promote**: move a `needs_review` document to `searchable` (public). Only
  `needs_review → searchable` is allowed — you cannot promote a `draft` or
  `error` doc directly (it must go through the pipeline first).
- **Re-ingest**: re-queue the document for the worker to re-process.

### Documents (`/admin/documents`)

The full catalog. Filter by status, language, collection, or search by title,
external ID, author, or DOI. Click a document to open the editor.

### Document editor (`/admin/documents/[id]`)

Edit document metadata (title, title_en, DOI, authors, URL, date published,
publication, article type, WRI primary office, language). The "Source metadata
(read-only)" section shows the original CSV values. The Summaries panel lets
you edit the long and short summaries (native + English). Tags are grouped by
facet — accept/reject LLM suggestions, or add human tags. The lifecycle panel
shows extraction confidence and status with promote/withdraw/re-ingest/Open
PDF buttons.

### Collections (`/admin/collections`)

Collections are curated groups of documents (e.g. by topic, project, or
language). They support bulk operations and can carry a language policy and
embedding-model version for staged migration. A document can belong to
multiple collections.

### Tags (`/admin/tags`)

The controlled vocabulary (taxonomy v1). Facets: `program`, `office`, `topic`,
`doc_type`. Each document can carry multiple tags per facet. LLM-generated tags
are `suggested` until an editor accepts or rejects them (the decision flips the
tag's `source` to `human`, making it immutable to future LLM re-runs). Admins
can add and delete tag values.

### Upload (`/admin/upload`)

Upload PDFs to the intake queue. The ingestion worker (a separate process)
registers and processes them through the pipeline. The worker-status panel
shows whether the worker is running and the current queue depth. If the worker
is `stale` (not running), your files will not be processed until it starts —
contact an administrator.

### Users (`/admin/users`)

Admin-only. Create and manage admin/editor accounts. Editors can review, edit
metadata, manage tags/collections, and upload. Admins can additionally withdraw
documents, delete tag values, and manage users.

## The ingestion pipeline

When a PDF is uploaded, the worker processes it through six stages:

1. **parse** — extract full text + page boundaries from the PDF.
2. **language** — detect the primary language and the set present.
3. **summarize** — generate native + English long/short summaries via LLM.
4. **classify** — LLM classification against the taxonomy (confidence-gated).
5. **embed** — chunk the text, generate dense + sparse embeddings, write
   `document_chunks` rows.
6. **publish** — quality-gate (extraction confidence ≥ 0.7 → `searchable`;
   < 0.7 → `needs_review`).

If a stage fails, the job retries up to `WORKER_MAX_ATTEMPTS` (default 3)
before moving to `error`. Stale `running` jobs are reaped after
`WORKER_REAP_MINUTES` (default 15).

## Multilingual handling

AskWRI supports English, Spanish, Chinese, Portuguese, and Indonesian. Every
document has:

- A **primary language** (`documents.language`) and the **full set**
  (`documents.languages[]`).
- **Native + English summaries** (`document_summaries`) — the native summary
  is a per-language retrieval handle; the English summary is the bridge.
- **`title_en`** — the English rendition of the title: for English docs it
  equals `title`; for non-English docs the worker generates an LLM translation
  at ingest (refreshed if `title` changes). Editable; an admin edit is protected
  from future re-ingest overwrites.

Chinese text is OpenCC Traditional→Simplified normalized in chunks only
(`document_texts` retains the original).
