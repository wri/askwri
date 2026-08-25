# Upload Journey — Design

**Date:** 2026-07-09
**Status:** Approved direction (batch green light; David chose session-only tracking)
**Scope:** Admin upload page + read-only status polling via existing endpoints. No schema changes, no intake API changes beyond what its response already carries.
**Guiding constraint:** simplicity — no persistence, no new attribution.

## Problem

The upload page is a bare file input: no drag-and-drop despite copy that says "drop PDFs", no per-file outcome, and no way to watch your files move through the pipeline — duplicates silently vanish and users hunt the shared review queue to find their uploads.

## Design

### 1. Dropzone

The file input area becomes a styled drop target (dashed border, "Drop PDFs here or click to choose"). Drag-over highlights; drop assigns `dataTransfer.files` (filtered to `.pdf`, non-PDFs listed as rejected) into the existing upload flow. The native `<input type='file' multiple>` remains inside for click-to-choose and keyboard/screen-reader access (`aria-label`). No dropzone library.

### 2. Per-file session tracking list

After each upload, the page appends the batch to a session list (component state only — gone on page leave, per the approved scope). Each entry: filename, external_id stem, and a live status resolved by polling:

- **uploaded** → intake accepted the file (from the existing `/api/admin/intake` response).
- **registered / processing** → a `documents` row with `external_id = <filename stem>` exists: poll `GET /api/admin/documents?search=<stem>&limit=5` every 5 s (single shared interval for the whole list, not per file) and match on exact externalId; show the doc's live StatusChip and a link to its editor page.
- **searchable / needs_review / error** → terminal statuses from the same poll; polling for that entry stops.
- **likely duplicate** → not registered after 90 s AND worker health shows zero intake backlog (both signals from existing endpoints); shown with a tooltip explaining content-hash dedup. This is an inference, labeled as such ("likely"), because dedup-skip is not queryable per file.

The shared interval stops entirely when every entry is terminal or the list is empty. Poll failures degrade silently (entries stay at their last known state).

### 3. Copy

The intro keeps the duplicate-skip explanation; the worker-status panel is unchanged. The "Track progress in the Review queue" pointer remains for anything beyond the current session.

## Non-goals

- No persistent "my uploads" (no uploaded_by attribution, no schema change).
- No upload progress bars (files are small; the multipart POST is a single await).
- No retry/cancel controls.

## Testing

Component tests (fake timers for the poll): drop event populates and uploads; per-file entries render; a poll response containing the doc flips the entry to its status chip + editor link; the likely-duplicate inference fires only after the timeout with zero backlog; polling stops when all entries are terminal; non-PDF drop is rejected with a message.

## Acceptance

An editor can drag five PDFs onto the page, see each one's outcome individually (including a labeled "likely duplicate"), watch statuses update live while they stay on the page, and click through to any registered document — without touching the review queue.
