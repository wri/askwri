# Building blocks and optional modules — exploration record

**Date:** 2026-10-15
**Status:** exploration concluded. This records the architecture conclusion and what it cost to
reach; it is **not** a spec and nothing here is approved for build.
**Question it answers:** what would it take to make AskWRI easier to build on — a required core
of building blocks plus optional blocks and extensions, so other groups can stand up their own
and extend them.

## 1. The conclusion in one paragraph

The system has **five core blocks**, **one missing mechanism**, and **one standing discipline**.
The mechanism is dimensions and taxonomies as data. The discipline is labelling: deciding what
is core, what is a block, and what "off" means. Everything else that looked like an
architecture problem turned out to be either already present in the code, or out of scope. No
plugin framework, no tenancy, no core extraction is needed to act on this conclusion.

## 2. The five core blocks

A block is core by one rule: **every deployment needs it on day one, and everything else may
assume it exists.**

| Block | What it is | What exists today | What's missing |
|---|---|---|---|
| **Corpus store** | documents, their text, chunks, a vector per chunk | `documents`, `document_texts`, `document_chunks`, `keyword_vocab` — the last two are raw SQL, no entity | nothing structural; per-tenant field sets are the mechanism problem in §3 |
| **Ingestion** | source in, rows out, dimensions populated | worker stages: parse → language → summarize → classify → embed_tags → embed → relate → publish | PDF-only intake (`intake_s3.py` globs `*.pdf`); no source-type abstraction |
| **Retrieval** | question in, ranked passages out | `/query` (dense + sparse + RRF + Bedrock rerank), frozen contract | nothing; this is the part that works |
| **Read surface** | results out, citable, consumable by the app or anyone else | `/query` over HTTP. The MCP route is a **block**, not part of this surface — see `2026-10-15-block-switches-design.md` §4 | no surface for *metadata*: dimensions can't be read, filtered or aggregated by a caller |
| **Label review** | system takes a first pass, humans correct, human never overwritten | retrieve-then-classify over embedded names; precedence via `document_tags.source` | it is welded to WRI's taxonomy workflow, not usable against a stranger's vocabulary |

**Deliberately outside the minimum:** answer mode and synthesis, alignment, feedback logs,
taxonomy depth (merges, alias import/export, reclassify runs), relations, collections, health
dashboards, query understanding (expansion, spelling, topic sense), multilingual, eval and
calibration. All exist; all are blocks, not core.

Answer mode is the one worth calling out: it is a synthesis layer over retrieval, so a group
whose wish is "mostly answer mode" wants the core plus one block.

## 3. The one missing mechanism: dimensions and taxonomies as data

A **dimension** is what you measure; a **taxonomy** is the value vocabulary for it. They are one
mechanism at different richness — flat values, values with synonyms, or a hierarchy. The owner's
call: dimensions must be declarable **without touching code**, and an org must be able to upload
its own taxonomy. Code-level extensions stay the org's own job.

**Seeds already in the code** (this is why the mechanism is small, not absent):

- `FacetSpec{facet, value}` is open-typed in the frozen contract — "loose on purpose"
- filter option lists are derived from the catalog, not hardcoded
- `source_metadata` / `metadata_source` jsonb is a live write path at ingest
- tagging is retrieve-then-classify over *embedded names* (`TAG_CANDIDATE_TOP_N`,
  `tag_confidence_accept`, `embed_tags`), so the classifier does not know whose vocabulary it is
- human-outranks-machine precedence already exists (`document_tags.source`)
- a taxonomy import/export lane already exists (`admin/topics/import`, `/export`, tag aliases)

**What is missing:** a declared dimension registry; a generic filter implementation (only five
filters exist — `year_min`, `year_max`, `office`, `program`, `language`, plus excluded keywords);
a generic way to render a declared dimension; and an org-supplied taxonomy path.

**The rich unknown is not the storage.** It is that label quality is per-taxonomy: the first pass
is good on WRI's corpus and unknown on a stranger's, so every new vocabulary re-opens the
calibration question.

## 4. The one discipline: labelling blocks

Today there is **no unit of a block**. Cite mode exists simultaneously as a mode branch inside a
2,264-line `main.py`, a preset in `src/config/retrieval.ts`, and a page in the app. Answer mode
the same. The system has capabilities but no unit of capability, which is why adding one means
finding the right spot in four layers — exactly what experts mode and the MCP tool did.

Three decisions that define the discipline:

- **"Off" means present-but-hidden.** Owner's call. So the minimum viable product is a
  deployment of the existing app with blocks hidden, not a second codebase. No separability work.
- **The core team owns every block for now**, with the intent to transition some away over time.
  Blocks buy *legibility* today, ownership later.
- **Reference implementations ship as examples**, one per kind of block, not one per capability:
  a variation on the machinery (answer mode), a new reader (MCP), a retrieval variant (expert
  finder). That is enough to make "write your own block" legible.

**Predicted transfer order**, by WRI-specificity: general blocks go first — answer mode, MCP,
multilingual, query understanding. The WRI-welded ones stay longest — taxonomy and tagging,
thresholds, calibration, eval sets, judgment capture.

## 5. Approaches considered, and why not now

Full survey in this file's history. Compressed:

| Approach | What it buys | Why not now |
|---|---|---|
| Plugin framework (registry, lifecycle, entry points) | third-party modules in one host | hidden blocks need a flag and a place, not a registry; only pays off with several consumers per extension point |
| Single-instance tenancy (orgs, row scoping) | shared upgrades, one corpus | out of scope by instruction; nothing in the code conceives of it (auth is one install, two roles) |
| Core extraction at a boundary (schema-cut or HTTP-cut) | a distributable core | only worth doing once blocks are labelled; also a published boundary is a permanent promise |
| Fork per tenant with an upgrade runbook | maximum freedom, zero design | the fork tax is permanent, and it makes the WRI assets stop compounding |
| Formal provider interfaces | swap parser / embedder / reranker / LLM | the seams already exist as env switches; formalize lazily, one at a time |
| Calibration and evals as a portable module | correctness on someone else's corpus | the harness is code (20k LOC), only the sets are data; real cost is producing labels |
| **Generic dimensions and facets** | **org-defined metadata, no code** | **survives — this is §3** |

## 6. Out of scope, by instruction

- **Instances, accounts, upgrades** — who hosts what and who moves a copy forward: out of scope
  for this exploration.
- **License and public boundary** — parked, not resolved. Note that a stranger-facing release is
  still the stated change-condition for several deferred items.
- **Retrieval-quality work** — out of scope, which matters for risk 1 below.

## 7. Risks that survive any simplification

1. **Label quality is per-taxonomy.** The generic mechanism makes a stranger's vocabulary
   *possible*; it does not make the first pass *good*. Calibration capacity is the constraint the
   product vision names, and every new vocabulary spends it.
2. **Hidden blocks still ship.** Every build carries WRI's taxonomy, calibration and eval
   machinery whether or not anyone can see it. Cheap now, confusing later, and flags do not fix it.
3. **The assets-versus-handoff tension.** The blocks easiest to hand to another group are the
   least valuable to hand off; the most valuable (corpus judgement, eval sets, thresholds) are the
   ones nobody else could maintain.
4. **Labour.** Label review, calibration and eval draw on the same scarce capacity.

## 8. As-built facts behind this record

Measured on branch `docs/building-blocks-design` off `qa` @ `154c38d`:

| Concern | Weight |
|---|---|
| `src/app` (Next.js, incl. admin UI) | 25.8k LOC |
| of which admin UI | 10.6k LOC, 12 pages, **38 admin routes** (59 API routes total) |
| `src/db` | 6.2k LOC, 68 files (queries 4.2k) |
| `src/lib` | 4.7k LOC |
| `search-service/app` | 6.0k LOC, `main.py` 2,264 lines, `routers/` empty |
| `search-service/worker` | 3.0k LOC |
| `evaluation` | 20.0k LOC; judgment data partly in the `eval-review` submodule |
| `terraform` | 2.4k LOC; RDS provisioned outside the repo |

Other facts this record rests on:

- **Two capabilities already shipped as app-tier modes:** experts (`api/experts` 310 lines,
  `experts/page.tsx` 696, `lib/experts/*`, `queries/expertsEvidence.ts`) and MCP
  (`api/mcp`, `lib/mcp/*`, tool `search_wri`). Both read Postgres directly and reuse
  `CITE_PRESET`.
- **The citation anchor is a page:** `Passage.page: Optional[int]` in the frozen contract,
  `document_texts.page_boundaries`, ~11 non-test `src/` files and ~6 render surfaces, plus MCP
  output formatting.
- **The corpus contract is WRI-shaped:** `wri_primary_office`, `publication_title`,
  `article_type`, `required_program`, `max_results: 150 # 203-doc corpus`, plus WRI keyword CSVs
  and tag aliases.
- **Deployment:** `qa` and `production` tfvars share one RDS host and `project_name`, differing
  by `DB_NAME`; a working self-contained local stack exists (pgvector Postgres + MinIO,
  `scripts/local-bootstrap.sh`).
- **`collections.visibility`** is declared and never read or written — a placeholder.

## 9. Provenance

An independent premise audit ran against the previous draft. It corrected two substantive
errors, both now folded in: (1) the expert finder and the MCP tool were recorded as future work
when both already exist as app-tier modes, and (2) the claim that calibration is the cheap module
because "its interface is data" was false — the harness is code, and the real cost is labels.
It also measured the citation-anchor surface, which the earlier draft called unmeasured. The
audit's remaining unstated premises are §7 above.

## 10. Open questions

- **Taxonomy richness:** flat values, values with synonyms, or hierarchy? Undecided.
- **How a group attaches its own page or tool:** inside the app, outside it, or both — the owner
  said "either," which means the read surface is the common requirement and the in-app path is
  the open one.
- **Who signs quality per taxonomy**, given risk 1.
- **Whether declared dimensions ride on the existing tag tables** or get their own structure.

## 11. Left to the builder

Deliberately unspecified: the dimension registry's shape, the generic filter and render
mechanisms, the org-taxonomy upload format, how blocks declare what they require, the block
labelling convention and where it lives, and migration ordering. Also unspecified: anything
about packaging, distribution or repository layout.
