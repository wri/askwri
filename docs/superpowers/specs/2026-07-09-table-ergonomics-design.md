# Table Ergonomics — Design

**Date:** 2026-07-09
**Status:** Approved direction (batch green light); spec authored from the UX-review backlog
**Scope:** Documents catalog page + its list query. Review queue is excluded (it's a work queue, not a browsing surface).
**Guiding constraint:** simplicity — sort + shareable URLs, nothing else.

## Problem

The catalog can't be sorted (fixed newest-first) and filter state lives only in component state: refresh loses it, back button loses it, and a filtered view can't be shared.

## Design

### 1. Server-side sorting

`listAdminDocuments` (src/db/queries/documentsAdmin.ts) gains optional `sort` and `dir` params validated against a whitelist — `{ title, year_published, status, created_at } × { asc, desc }` — appended to the ORDER BY (always with the existing `d.id DESC` tiebreaker; default unchanged: `created_at DESC`). The route passes them through with the same whitelist validation (reject → 400). No index changes (500-row scale).

### 2. Sortable headers

Title, Year, Status column headers become buttons: click toggles asc/desc for that column (third click returns to default). Active sort shows ▲/▼. `aria-sort` on the active `<th>`.

### 3. Filters + sort + page in the URL

All catalog state (status, language, year, collection, tag, search, sort, dir, page) is read from `useSearchParams` on load and written via `router.replace` (not push — no history spam) on every change, omitting defaults/empties. The existing inbound `?collectionId=` deep link keeps working unchanged. Copying the URL reproduces the exact view; refresh and back/forward preserve it. The debounced search (feedback-layer slice) writes its settled value to the URL, not per keystroke.

## Non-goals

- No multi-column sort, no saved views, no column chooser.
- No review-queue sorting.
- No pagination redesign (Prev/Next stays).

## Testing

DB test: whitelisted sort orders applied correctly, invalid sort rejected by the query fn (or route test for the 400). Component tests: header click cycles asc/desc/default with aria-sort; state round-trips through the URL (render with searchParams → filters applied; change a filter → router.replace called with the right query string).

## Acceptance

An editor can sort the catalog by year, filter to Spanish 2023 docs, copy the URL to a colleague who sees the identical view, refresh without losing it, and return to default order in one click.
