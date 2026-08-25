# Review Throughput — Design

**Date:** 2026-07-09
**Status:** Approved by David (brainstorming session)
**Scope:** Admin UI only — review queue page + document editor page. No schema changes, no new API endpoints, no worker changes.
**Guiding constraint:** simplicity. Reuse existing surfaces and endpoints; add no state machinery the solo-reviewer reality doesn't need.

## Problem

The core admin workflow — batch upload → N documents land in `needs_review` → review each → promote — is one-document-at-a-time. Each document costs a queue→editor→queue round trip, the lifecycle actions sit at the bottom of a six-panel page, and there are no bulk operations. For a 20-document batch that's ~60 navigations.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| First slice of the UX-review themes | Reviewer throughput (history panel, feedback layer, upload journey, a11y, URL state = later specs) |
| Review depth | Mixed/triage: bulk-promote the obviously-fine, inspect the rest |
| Concurrent reviewers | Usually one — no claiming/locking; degrade gracefully on rare collisions |
| Triage signal | Current queue columns suffice (title, language, confidence, why-flagged, tag count) — no row redesign |
| Inspection surface | **A: guided editor pass** — review bar on the existing editor (chosen over split-pane desk and drawer; the docs you open need real fixes, and fixes live in the editor) |

## Design

### 1. Queue: selection + bulk bar

- Checkbox column with select-all on the review queue table (same pattern as the documents page).
- When ≥1 row selected, a bulk bar appears with **Promote selected** and **Re-ingest selected**.
- Both actions show a `window.confirm` stating the count ("Promote 8 documents to public search?").
- Execution: client-side `Promise.allSettled` loop over the **existing per-document endpoints** (`POST /api/admin/documents/[id]/status`, `POST /api/admin/documents/[id]/reingest`). No new API; audit rows remain per-document.
- One queue+health refetch after the whole batch, not per action.
- Result notice reports honestly: "6 promoted, 2 failed — <title>: <reason>". Failed rows remain selected after refetch so retry is one click.
- Server already rejects promoting `error`-status docs; the bulk bar disables Promote when the selection contains any, with a `title` tooltip explaining why.

### 2. Editor: guided review bar

- The editor shows a pinned review bar **iff the open document is currently in the review queue**. Queue membership is the only trigger — no URL params, no session storage.
- Bar contents: "Reviewing N of M flagged" + **← Prev / Promote / Re-ingest / Skip →**.
- Position: the editor fetches the review queue (existing `GET /api/admin/review-queue`) and finds the current doc's index. Count and ordering therefore stay live as the queue shrinks.
- **Promote** and **Re-ingest** act on the current doc and auto-advance to the next queue doc on success. **Skip** advances without acting. Prev/Next disable at the boundaries.
- The queue page gets a **"Start reviewing (M)"** button that opens the first flagged doc. Clicking any row title enters the pass at that doc's position (no special link handling needed — the bar appears because the doc is in the queue).
- **Advance on action success is authoritative.** The queue predicate (`status IN (needs_review, error) OR latest job errored`) can transiently keep a just-promoted doc in a refetched queue via a stale errored-job row. After a successful Promote/Re-ingest response, advance to the next doc regardless of what a refetch says about the acted-on doc.

### 3. Editor: panel reorder

Lifecycle (status chip, confidence, latest job/error, action buttons) moves from fifth position to the top, directly under the review bar. New order: lifecycle → metadata → tags → summaries → source metadata → collections. This serves every editor visit, not just review passes.

### 4. Edge cases

- **Doc acted on by someone else mid-pass** (rare per the solo-reviewer decision): the doc is no longer in the fetched queue → the bar renders "No longer in the review queue" with a single **Next** button. No locking.
- **Queue empties mid-pass:** bar shows "Review queue is empty 🎉" with a link back to `/admin/review`.
- **Bulk partial failure:** failures listed by title with the server's reason; failed rows stay selected.
- **Bulk Promote with an `error`-status doc selected:** button disabled + tooltip (mirrors the server rule instead of surfacing per-row failures).

### 5. Testing

Jest (jsdom) component tests only — no query-layer changes are made, and the per-doc endpoints are already covered by existing route/DB tests.

- Queue page: select-all toggling; bulk bar visibility; confirm gating; partial-failure notice rendering; Promote disabled when selection includes `error` status.
- Editor: review bar visible iff doc ∈ queue; "N of M" correctness; advance-on-promote/re-ingest/skip; boundary disabling; "no longer in queue" state.

## Non-goals

- No claiming/assignment, no locks, no per-reviewer queues.
- No bulk endpoint, no schema or worker changes.
- No queue-row redesign (summary snippets, tag chips in rows).
- The existing per-row Promote/Re-ingest buttons keep their current behavior (server-enforced errors only) — the error-status disable/tooltip applies to the bulk bar only.
- No changes to the other UX-review themes (history, toasts/loading, upload, a11y, URL filter state) — separate specs.

## Acceptance

A reviewer with a 12-document batch can: bulk-promote the obviously-fine subset from the queue in one action with one confirm; click "Start reviewing" and move through the remainder with Promote/Re-ingest/Skip without ever returning to the queue; and see lifecycle state at the top of every document page.
