# Dimensions and taxonomies as data — design

**Date:** 2026-10-15
**Status:** design for the one mechanism identified in
`2026-10-15-building-blocks-design.md` §3. The owner has taken the decisions in §5 and §8, including
the quality decision in §4.3.1. Not yet approved for build.
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
| Hierarchy | `tags.parent_tag_id` — populated and rendered today (geography continent→country trees; admin tree mode; parent/child enforced on delete and merge) | same; migration `1787251200000-GeographyFacet`, `tagsAdmin.ts`, `TopicTaxonomyManager.tsx` |
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
  filterable boolean default true,
  facetable boolean default true,
  display_order int,
  created_at, updated_at
)
```

Writing ownership: app tier owns `facets` (it is admin-declared configuration). The Python side
only reads it.

**Existing dimensions backfill from `tags`** in the same migration: every distinct `tags.facet`
becomes a `facets` row. The tag facets that actually exist today are `program`, `office`,
`topic`, `doc_type` and `geography` — note that **`language` and `year` are document columns**,
not tag facets, read through the catalog and `docs_meta`. They are therefore not registry rows
and keep their existing legacy filters. There is no column-backed dimension in this design:
**every dimension's values live in `tags`**, and a mapping (§4.3) is what writes tag rows from
source metadata at ingest. The registry also replaces the two duplicated facet allowlists
(`CANONICAL_FACETS` in `src/db/queries/tagsAdmin.ts` and the admin tags page) as the single
source of truth, so the migration must backfill all five facets or existing admin flows stop
working. This is the answer to "what happens to WRI's taxonomy": it is not migrated or rewritten
— it becomes the first rows of the registry, and WRI's columns (`wri_primary_office`,
`publication_title`, `article_type`) stay exactly where they are, since they already have code
paths. Demoting them into generic dimensions is a later, separate act.

### 4.2 Declaring a dimension without code

Admin CRUD over `facets`, plus taxonomy values written into `tags` and synonyms into
`tag_aliases`. Reuse the existing topics import/export shape for bulk upload (CSV or JSON of
`facet, value_id, label, description, parent`), and the existing admin route patterns for
single-item CRUD. No new editor paradigm.

**Rule:** declaring a dimension never requires code or a migration — it requires configuration and
a classification run. That is the precise form of "no code", and it is the acceptance test for
this section.

### 4.3 Populating values

Three paths, in precedence order (highest wins, and lower paths never overwrite a higher one):

1. **Org-supplied labels** at ingest — the org may state which documents carry which values, via
   the document import path (`source='external'` in `document_tags`).
2. **Human correction** in the admin UI — `source='human'`, `status='accepted'`.
3. **System first pass** — the existing classify stage writes `source='llm'` with `confidence`
   and `status` from `tag_confidence_accept` (`suggested` below threshold, `accepted` above).

This is the existing invariant, restated: the Python side never touches `source='human'` or
`'external'` rows. Precedence is therefore enforced by the writer rule plus a read-time ordering,
not by a merge step. **Precedence is per value, not per facet.** `document_tags` is keyed `(document_id, tag_id)`, so
a human row and a machine row for the same value cannot coexist — the invariant is structural.
Collapsing per facet would let one human correction hide every other machine value on a
multi-valued dimension. **Call:** rows that are live for filtering and counts are
`status='accepted'`, matching `src/db/queries/documentsAdmin.ts:110-111` and
`expertsEvidence.ts:74`; `suggested` rows are counted and shown for review but never filtered on.

**Mapping from source metadata:** the classify stage gains one declared mapping — for each
declared dimension, which `documents.source_metadata` key (or org-supplied column) supplies its
value. Mapping is registry data, so a new dimension needs no code. Dimensions with no mapping are
classified rather than read.

### 4.3.1 Per-dimension classification config

**Owner's decision: tuned quality, not a rough first pass.** A declared dimension is expected to be
classifiable as well as filterable, so the configuration that is hardcoded today becomes registry
data.

The classifier has two lanes today, and only one of them is quality-grade:

- **retrieve-then-classify** — candidate values retrieved from an embedded shortlist, with a
  per-facet prompt and cap. Gated by `EMBEDDED_FACETS = ("topic", "geography")` and
  `_FACET_CONFIG[facet]` in `search-service/worker/stages/classify.py:26-56`.
- **full-enum** — every remaining facet shares one unbounded prompt with no per-dimension
  control (`classify.py:259-291`).

Design changes:

1. `facets` grows classification columns: `candidate_retrieval boolean` (replacing membership in
   `EMBEDDED_FACETS`), `classify_prompt text`, `classify_max_items int`, `classify_max_tokens int`.
2. The classifier reads that config from the registry instead of the hardcoded dict, so adding a
   quality-grade dimension is a row plus a form, not a code edit.
3. Embedding a dimension's values into `tag_embeddings` becomes an admin-triggered job rather than
   a side effect of `EMBEDDED_FACETS` membership (`embed_tags.py:110-113`). Declaring a tuned
   dimension therefore queues a build; it does not require a deploy.
4. The full-enum lane survives as the fallback for dimensions declared without config. It is no
   longer the supported path for anything that matters.

**Not automated.** No prompt or cap is inferred. A human writes the dimension's prompt and picks
its cap; the system does not tune itself (§6).

**Cost consequence:** this is the bulk of the project. The estimate moves to the top of L.

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
- **Taxonomy version stays vestigial.** Every existing path hardcodes `'v1'` (`classify.py`,
  `embed_tags.py`, `tagsAdmin.ts`, `topicsAdmin.ts`); no mechanism reads another version. A
  re-upload replaces values in place within the current version. Multi-version is an explicit
  non-goal (§6), and `facets` therefore carries no version column.

**Correctness, not just performance.** Facets are applied post-fusion, over nodes retrieval
already returned (`search-service/app/main.py:1687-1697`, `facet_filter.apply_facet_filters`), so
a filter can only remove. For a narrow declared dimension — say twelve documents out of five
thousand — a chip would usually return nothing even when matching documents exist. **Call:**
declared-dimension filtering must reach the query planner as a pre-filter, or use a materialized
`document_facets` view from day one. That is why the first migration may need an aggregate index:
as a correctness fix it cannot be deferred, and it cannot be retrofitted cheaply.

### 4.5 Rendering

Options for a declared dimension come from `tags` (values) joined to `facets` (whether it is
facetable, and where it sits in the order), following the pattern already used by
`filterOptions.ts` for language and office. Chips submit `FacetSpec{facet, value}` unchanged.
A dimension with `facetable=false` is not offered as a chip but remains filterable by explicit
request (this is what lets an extension filter without cluttering the UI).

**Parent values get no chip.** A chip on a parent resolves to zero documents, because nothing
writes `document_tags` for parents — the worst failure mode for a stranger's first taxonomy.
Parents stay storable and renderable (the existing geography and topic trees already do this) and
the read surface may group by them; roll-up filtering is out of scope (§6).

**Options for the app's own chip panel do not come from the §4.6 endpoints.** That panel is
public browser code with no key; it keeps using the app's catalog path, exactly as
`/api/catalog` already does.

### 4.6 Read surface for extensions

One authenticated read endpoint, modelled on `src/app/api/mcp/route.ts` (shared key via
`MCP_SHARED_KEY`, fail-closed, header or query parameter):

- `GET /api/dimensions` → declared dimensions and their metadata
- `GET /api/dimensions/{name}/values` → values with document counts
- optionally `GET /api/dimensions/{name}/counts?group_by=<dimension>` → cross-tab, for charts

This is the surface a group's own page or tool reads to build a visualisation. It is deliberately
read-only and dimension-shaped, not a general query engine.

**Two surfaces, two audiences.** The app's chip panel is unauthenticated browser code and uses
the catalog path (§4.5); the endpoints above are key-protected. So a group's taxonomy is exposed
to the public web exactly to the extent its chips are — a product decision, not a default that
falls out of the implementation.

## 5. Decisions made here (mine, correct any)

1. **Dimensions ride the existing tag tables.** Not a preference — `tags(facet, value_id,
   taxonomy_version)` already *is* the dimension model and the classifier already writes to it.
2. **Richness: flat values plus synonyms** (`tag_aliases`). Hierarchy is not foreclosed — it is
   already stored *and rendered* for geography and topic — but roll-up filtering is deferred.
3. **Hierarchy roll-up deferred.** Parent/child values store and render; no roll-up filtering, no
   parent chips (§4.5).
4. **WRI's existing fields are not migrated.** They stay as columns with their current code
   paths; they join the registry as dimensions over time.
5. **The registry is a new table, not a column on `tags`.** Dimension-level facts belong to the
   dimension, not to each of its values, and the registry replaces the two duplicated
   `CANONICAL_FACETS` lists as the single source of truth.
6. **Taxonomy versioning is vestigial** — re-upload replaces in place (§4.4, §6).
7. **Filtering is `accepted`-only**, and declared dimensions must pre-filter rather than
   post-filter (§4.3, §4.4).
8. **Classification quality is tuned per dimension** (owner's call, §4.3.1): config lives in the
   registry, the embedding build becomes an admin job, and the full-enum lane is a fallback rather
   than the supported path.

## 6. Explicitly not this design

Answer mode, expert mode, MCP's search surface, collections, relations, the eval and calibration
lane, block labelling/refactoring, tenancy, packaging, any `/query` contract change, taxonomy
multi-versioning, hierarchy roll-up filtering, and any automatic tuning of a dimension's prompt or
cap.

## 7. What is left to the builder

Route and schema naming, the taxonomy upload file format, the exact mapping declaration shape,
the in-process cache's TTL and invalidation, whether the generic filter path needs a materialized
view at corpus scale, the admin UI's arrangement, migration ordering, and test strategy.

## 8. Decisions and open questions

**Q1 — answered (owner).** Tuned per-dimension quality, not a rough generic pass. Every declared
dimension is expected to carry classification config; the full-enum lane remains only as a
fallback. See §4.3.1 for what that moves into the registry, and note the cost consequence: this is
the bulk of the project.

**Q2 — my call.** The acceptance test uses one placeholder dimension that exists in no code today
("intervention type" over a small document set), so the test can fail against something real. Swap
in the owner's own dimension name when one exists.

**Q3 — my call.** The cross-tab read (`counts?group_by=`) is out of the first cut. One dimension's
values and counts are what a first visualisation needs; a two-dimensional grid needs a different
index and can follow.

**Q4 — my call.** Org-supplied labels (`source='external'`) stay out of the first cut. The
precedence ladder is defined and the import path is additive, so the top rung can ship later
without rework — but until it does, "system classifies, humans correct" is the whole story.

**Still open, and only the owner can answer:** which real dimension is the first acceptance case
(Q2's placeholder is a stand-in), and whether the first cut ships against a real group's corpus or
a seeded test set.

## 9. What the builder check changed

A fresh builder read this design and found four citation errors and one correctness bug, all fixed
above: `parent_tag_id` is in use (geography and topic trees), not unused; `language`/`year` are
document columns, not tag facets, so the backfill list and the `derived` value-source were wrong;
precedence is per value, not per facet, because of the `document_tags` primary key; taxonomy
versioning is vestigial everywhere, not a live axis; and post-fusion filtering is a *correctness*
problem for narrow dimensions, not a performance one.
