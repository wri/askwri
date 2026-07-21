# Document History — Design

**Date:** 2026-07-09
**Status:** Approved by David (brainstorming session; option B — dedicated lazy-loaded endpoint)
**Scope:** Admin UI + one new read-only API route + one query function. No schema changes, no new writers, no worker changes.
**Guiding constraint:** simplicity. Render what `audit_log` already holds; no synthesis, no event taxonomy.

## Problem

Every app-tier mutation is audited (`audit_log`: actor, source, action, entity, before/after jsonb, timestamp), but none of it is visible in the UI. There is no undo anywhere; visible history is the compensating control. Reviewers can't answer "why did this field change?" or "who promoted this?"

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Where | Editor panel only — a "History" section on the document page (global activity feed deferred) |
| Entry detail | One-liner, expandable — "who · what · when", click to expand before→after values |
| Event scope | Everything recorded — every event audit_log holds for the doc, no filtering (in practice: human edits, imports, intake events; see the coverage-gap note) |
| Data delivery | **B: new endpoint, lazy-loaded** — `GET /api/admin/documents/[id]/history`, fetched when the panel is first expanded (chosen over extending the detail endpoint, which would tax every editor load) |

## Design

### 1. API

- New route `src/app/api/admin/documents/[id]/history/route.ts` → `initializeDatabase()` → new query fn `src/db/queries/documentHistory.ts` (repo convention).
- Auth: `requireIdentity` (any authenticated identity — same as the detail endpoint).
- Request: `GET .../history?limit=20&offset=0`. Response: `{ ok: true, total, entries: [{ at, action, entityType, actor, source, before, after }] }` ordered `at DESC`.
- `actor`: username via `LEFT JOIN users ON users.id = audit_log.actor_user_id`; when NULL, fall back to the row's `source` value. **Reality check:** `source` only ever holds `'human'` or `'system'` (token API calls, CSV imports, and worker writes all record `system`) — the fallback label is therefore just "system". Distinguishing worker/import/token sub-actors would need a writer change and is out of scope.
- Scope: rows where `entity_id = <document id>`. **Plan verification step:** confirm which document-scoped writers (tag decisions, summary edits, lifecycle, imports, intake, **collection membership** — known to record under `entity_id = collectionId`) record under the document's id vs another entity id; include other ids only if it is a trivial additional OR clause (e.g. ingestion-job ids via one subquery) — otherwise defer those event types rather than engineer around them.

### 2. Editor panel

- A collapsed `<details>` section titled **History** at the bottom of the editor (after Collections). First expand triggers the fetch; a short "Loading…" line covers the request.
- Entry one-liner: `{actor} · {verb + changed fields} · {relative time}` — e.g. "jane · updated title, authors · 2h ago", "jane · status → searchable · Jun 30", "system · import · Jun 12". Changed-field names come from the keys of the stored `after` jsonb; the action verb from `action`. No mapping tables beyond a tiny verb lookup (`update` → "updated", `lifecycle` → "status", `import`/`create`/`delete` as-is); unknown actions render raw.
- **Known coverage gap (accepted):** worker pipeline stages (publish, language detection, LLM extraction/summaries) write no audit rows today — only intake registration/duplicate-skip does. History therefore shows human edits, human lifecycle actions, CSV imports, and intake events; automated pipeline changes won't appear until audit writers are added (explicitly out of scope here, possible small follow-up).
- Clicking an entry expands a two-column before → after table rendered directly from the stored jsonb (same value rendering as the source-metadata table: strings as-is, everything else `JSON.stringify`).
- Latest 20 by default; if `total > 20`, a "Show all (N)" link fetches the remainder (single second request with `limit=total`).
- Empty state: "No recorded changes."

### 3. Edge cases

- Malformed/empty `before`/`after` (e.g. bulk-import audit rows with null entity granularity): the one-liner still renders from `action` + `source`; the expansion shows whatever exists or "no field detail recorded".
- Relative timestamps use the same `toLocaleString` fallback pattern as the rest of the admin UI for entries older than ~7 days — no date library added.

### 4. Testing

- DB test (`documentHistory.db.test.ts`): seed a doc + a few audit rows (human update, lifecycle, worker-style row with NULL actor) → assert ordering, actor resolution/fallback, total, limit/offset.
- Component test: panel collapsed by default (no fetch), fetch-on-expand, one-liner rendering, expansion shows before/after values, "Show all" appears when total exceeds the page.

## Non-goals

- No global activity feed page (later if wanted).
- No filtering, search, or grouping of events.
- No new audit writers, no backfill, no changes to what gets audited.
- No undo/restore actions from history entries.

## Acceptance

On any document page, an editor can expand History and see, without leaving the page: every **audited** change in reverse-chronological order — human metadata/summary/tag/lifecycle actions with the acting username, CSV imports, and intake events — with before/after values one click away. Automated pipeline changes are absent by design (no audit rows exist for them; see the accepted coverage gap).
