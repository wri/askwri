# Dimensions and taxonomies as data — design

**Date:** 2026-10-15
**Status:** design for the one mechanism identified in
`2026-10-15-building-blocks-design.md` §3. Nothing here is approved for build.
**Builds on:** that record's conclusion (five core blocks; one missing mechanism; one discipline).

## 1. Problem and scope

AskWRI's metadata vocabulary is WRI's. A group with its own corpus cannot declare a dimension
the code has never heard of, and cannot supply its own taxonomy, without editing code. The
exploration record concluded this is the only genuine engineering gap between today's system and
a "core blocks + optional blocks" model.

**In scope:** declare dimensions without code; upload a taxonomy; populate values; filter and
render on them; read them from outside.

**Out of scope:** multi-tenancy, packaging/distribution, block refactoring, changes to answer
synthesis or retrieval quality, hierarchy *UI* (see §5.3), and any change to the `/query`
request/response contract.

## 2. What already exists — the decisive finding

The dimension model is already in the schema. This design mostly *exposes* it rather than
building it.

| Need | Already modelled | Where |
|---|---|---|
| A dimension | `tags.facet` — text, with `UNIQUE (facet, value_id, taxonomy_version)` | `src/db/entities/Tag.entity.ts`, migration `1781280000000:90-97` |
| A value | `tags.value_id` | same |
| Taxonomy versioning | `tags.taxonomy_version` | same |
| Hierarchy | `tags.parent_tag_id` (nullable, **currently unused**) | same |
| Dimension descriptions | `tags.description` | same |
| A label on a document | `document_tags(document_id, tag_id, source, confidence, model_version, status)` | `src/db/entities/DocumentTag.entity.ts` |
| Human-vs-machine precedence | `document_tags.source` ∈ `human`/`llm`/`external` + `status` ∈ `suggested`/`accepted` | same |
| Synonyms | `tag_aliases` | `src/db/entities/TagAlias.entity.ts` |
| Taxonomy upload/download | topics import/export routes, alias seeding from CSV | `src/app/api/admin/topics/import|export` |
| An open-typed filter request | `FacetSpec{facet: str, value: str}` — "loose on purpose", in the frozen contract | `search-service/app/main.py` |
| A facet-aware classifier | "matched_tags keyed by facet, scales to N facets (replaces topic_tags)" | `search-service/app/understanding.py:45` |
| Filter options derived from data | language and office option lists built from the catalog | `src/app/components/results/filterOptions.ts` |

**So a dimension is a `tags.facet`, and a label is a `document_tags` row.** Nothing about the
storage, the classifier's vocabulary-independence, or the precedence invariant has to be invented.

## 3. The actual gaps

1. **No registry.** A dimension is implied by rows in `tags`, so it has no place to hold
   dimension-level facts: display label, whether it is filterable, whether it is facetable in
   the UI, display order, description, who declared it.
2. **Filtering is closed.** `search-service/app/understanding.py:26-27` types facets as
   `Literal["year_min", "year_max", "language", "program", "office", "excluded_keyword"]`, and
   `facet_filter.apply_facet_filters` handles those by hand (135 lines). Anything declared in
   `tags` cannot be filtered on.
3. **Rendering is closed.** Filter option lists exist for language and office specifically; there
   is no path from "declared dimension" to "chips and options."
4. **No read surface for metadata.** MCP exposes search results only. Nothing exposes dimension
   values or counts to a caller.

## 4. Design

### 4.1 The registry (`facets`)

One new table, owned by the app tier:

```
facets(
  id uuid pk,
  name text unique,            -- the value used in tags.facet and in FacetSpec.facet
  label text,                  -- what a human sees
  description text,
  value_source text,           -- 'declared' (taxonomy uploaded) | 'derived' (from documents)
  filterable boolean default true,
  facetable boolean default true,
  display_order int,
  created_at, updated_at
)
```

Writing ownership: app tier owns `facets` (it is admin-declared configuration). The Python side
only reads it.

**Existing dimensions backfill from `tags`** in the same migration: every distinct
`tags.facet` becomes a `facets` row, with `filterable`/`facetable` set by hand in the migration
for the ones that already have filters (`office`, `program`, `language`, `year`, `topic`). This
is the answer to "what happens to WRI's taxonomy": it is not migrated or rewritten — it becomes
the first rows of the registry, and WRI's columns (`wri_primary_office`, `publication_title`,
`article_type`) stay exactly where they are, since they already have code paths. Demoting them
into generic dimensions is a later, separate act.

### 4.2 Declaring a dimension without code

Admin CRUD over `facets`, plus taxonomy values written into `tags` and synonyms into
`tag_aliases`. Reuse the existing topics import/export shape for bulk upload (CSV or JSON of
`facet, value_id, label, description, parent`), and the existing admin route patterns for
single-item CRUD. No new editor paradigm.

**Rule:** declaring a dimension never requires a migration. That is the whole point, so it is the
acceptance test for this section.

### 4.3 Populating values

Three paths, in precedence order (highest wins, and lower paths never overwrite a higher one):

1. **Org-supplied labels** at ingest — the org may state which documents carry which values, via
   the document import path (`source='external'` in `document_tags`).
2. **Human correction** in the admin UI — `source='human'`, `status='accepted'`.
3. **System first pass** — the existing classify stage writes `source='llm'` with `confidence`
   and `status` from `tag_confidence_accept` (`suggested` below threshold, `accepted` above).

This is the existing invariant, restated: the Python side never touches `source='human'` or
`'external'` rows. Precedence is therefore enforced by the writer rule plus a read-time ordering,
not by a merge step. **Call:** read-time precedence takes the highest-ranked source per
`(document, facet)`, rather than storing a single canonical row per facet.

**Mapping from source metadata:** the classify stage gains one declared mapping — for each
declared dimension, which `documents.source_metadata` key (or org-supplied column) supplies its
value. Mapping is registry data, so a new dimension needs no code. Dimensions with no mapping are
classified rather than read.

### 4.4 Filtering — inside the frozen contract

`/query` does not change. `FacetSpec{facet, value}` is already open-typed, so a declared
dimension arrives with no contract edit.

The work is server-side only:

- Replace `understanding.Facet`'s closed `Literal` with `str`.
- In `facet_filter`, keep the five legacy branches untouched for compatibility, and add one
  generic branch: resolve `facet` → `facets` row → matching `tags` rows (respecting
  `taxonomy_version` and resolving `tag_aliases`) → document id set → filter.
- Resolve once per request, cache in-process per (facet, value) with a short TTL; this is a read
  of small, slow-changing tables.
- If the facet is unknown, drop the chip rather than erroring — matching the contract's existing
  "loose on purpose" stance.

**Risk to validate in planning:** the document-id set filter must not degrade the hybrid path at
corpus scale. If it does, the fallback is a materialized `document_facets` view refreshed on
write, which is why this is called out as a plan-level decision rather than a design one.

### 4.5 Rendering

Options for a declared dimension come from `tags` (values) joined to `facets` (whether it is
facetable, and where it sits in the order), following the pattern already used by
`filterOptions.ts` for language and office. Chips submit `FacetSpec{facet, value}` unchanged.
A dimension with `facetable=false` is not offered as a chip but remains filterable by explicit
request (this is what lets an extension filter without cluttering the UI).

### 4.6 Read surface for extensions

One authenticated read endpoint, modelled on `src/app/api/mcp/route.ts` (shared key via
`MCP_SHARED_KEY`, fail-closed, header or query parameter):

- `GET /api/dimensions` → declared dimensions and their metadata
- `GET /api/dimensions/{name}/values` → values with document counts
- optionally `GET /api/dimensions/{name}/counts?group_by=<dimension>` → cross-tab, for charts

This is the surface a group's own page or tool reads to build a visualisation. It is deliberately
read-only and dimension-shaped, not a general query engine.

## 5. Decisions made here (mine, correct any)

1. **Dimensions ride the existing tag tables.** Not a preference — `tags(facet, value_id,
   taxonomy_version)` already *is* the dimension model and the classifier already writes to it.
2. **Richness for now: flat values plus synonyms** (`tag_aliases`). `tags.parent_tag_id` already
   permits hierarchy, so nothing forecloses it; §5.3 defers only the hierarchy UI and the
   roll-up semantics.
3. **Hierarchy UI deferred.** Parent/child values can be stored; no roll-up filtering, no tree
   rendering.
4. **WRI's existing fields are not migrated.** They stay as columns with their current code
   paths; they join the registry as dimensions over time.
5. **The registry is a new table, not a column on `tags`.** Dimension-level facts belong to the
   dimension, not to each of its values.

## 6. Explicitly not this design

Answer mode, expert mode, MCP's search surface, collections, relations, the eval and calibration
lane, block labelling/refactoring, tenancy, packaging, and any `/query` contract change.

## 7. What is left to the builder

Route and schema naming, the taxonomy upload file format, the exact mapping declaration shape,
the in-process cache's TTL and invalidation, whether the generic filter path needs a materialized
view at corpus scale, the admin UI's arrangement, migration ordering, and test strategy.

## 8. Open questions for the owner

1. **Is a cross-tab read (`counts?group_by=`) in scope for the first cut?** A D3 visualisation of
   one dimension needs only values and counts; a grid of two dimensions needs the cross-tab, which
   is materially more work and a different index.
2. **Org-supplied labels at ingest** — does the document import path need to carry dimension
   values in this cut, or is "system first pass, then humans correct" enough to start?
3. **Which declared dimension proves the mechanism?** The acceptance test is a dimension that
   exists in no code today; naming it up front stops the work from quietly becoming a WRI-only
   refactor.
