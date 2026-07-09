# Feedback Layer — Design

**Date:** 2026-07-09
**Status:** Approved direction (batch green light); spec authored from the UX-review backlog
**Scope:** Admin UI only. One small shared component + mechanical adoption across the admin pages. No new dependencies.
**Guiding constraint:** simplicity — visible feedback, not a design system.

## Problem

Pages render empty tables while data loads (looks broken); success/error notices are pinned to the top of the page so actions performed while scrolled down appear to do nothing; nothing announces results to screen readers; the catalog search fires a request per keystroke; unsaved editor changes are silently discarded on navigation or tab close.

## Design

### 1. Shared `Flash` component (`src/app/admin/components/Flash.tsx`)

Replaces the inline `{notice && …}{error && …}` pairs. Renders a fixed-position container (bottom-right, `zIndex` above the sticky ReviewBar) with `role='status'` and `aria-live='polite'`:

- Success messages auto-dismiss after 6 s (with a close ×).
- Error messages persist until dismissed or replaced.
- API: `<Flash notice={notice} error={error} onDismiss={…} />` — pages keep their existing `notice`/`error` state and setters; only the rendering moves. No context/provider machinery.

Adopted on: review queue, documents list, editor, upload, import, tags, collections, users. The existing top-of-page banners are removed where Flash replaces them.

### 2. Loading states

Each page that fetches on mount gets a `loading` boolean (set false in a `finally`) and renders a single `<Text>Loading…</Text>` in place of its main table/panels while true. No skeletons, no spinners — one consistent line. Empty-state messages ("No documents found.") render only after loading resolves, never during it.

### 3. Debounced catalog search

`documents/page.tsx`: the search input updates local text state immediately but triggers `load()` via a 300 ms `setTimeout` debounce (cleared on each keystroke and on unmount). The existing request-sequencing guard stays.

### 4. Unsaved-changes protection (editor)

- A visible dirty indicator: the metadata **Save** button text becomes "Save (unsaved changes)" — driven by a small `dirty` state set alongside the existing `formDirty` ref (the ref alone can't re-render).
- `beforeunload` handler registered while dirty (covers tab close/refresh). App Router exposes no route-change event, so in-app navigation is NOT intercepted — accepted limitation, mitigated by the visible indicator and by the ReviewBar's existing dirty-preserving `load()`. Recorded here so nobody "fixes" it with a fragile hack later.
- Summary textareas already track per-summary dirtiness via disabled Save buttons — unchanged.

## Non-goals

- No toast library, no notification center, no queueing multiple toasts (latest message wins).
- No optimistic updates; no per-panel busy granularity changes.
- No public-app changes.

## Testing

Component test for `Flash` (renders notice, auto-dismiss timer via jest fake timers, error persists, aria-live attribute). Page-level assertions added to existing suites: loading line renders before fetch resolves (documents page); debounce collapses rapid keystrokes to one fetch (fake timers); dirty indicator appears after an edit and clears after save; `beforeunload` registered only while dirty.

## Acceptance

Every admin page shows "Loading…" instead of an empty shell; every action's outcome is visible from wherever the user is scrolled (and announced via aria-live); typing in catalog search fires one request per pause, not per key; editing then closing the tab warns; the Save button says when there's something to save.
