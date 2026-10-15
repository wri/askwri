# Building blocks and optional modules — design memo

**Date:** 2026-10-15
**Status:** exploration / decision memo. Nothing here is approved for build.
**Audience:** whoever plans and runs the next tenant of AskWRI, plus the person who
owns the product vision.

## Problem

AskWRI is one product for one corpus. The next groups who want it — a Comms team with
PDFs and blog posts, a research group with its own research PDFs sharing with outside
partners — currently cost about as much as the first one did, because the parts that
would have to change are spread across a 21k-LOC web app, a 5k-LOC retrieval service,
a 3k-LOC ingestion worker, and a corpus-tuned configuration nobody has inventoried.

The question this memo answers: **what would it take to make AskWRI easier to build on
— a required core plus optional modules — without painting ourselves into a corner that
makes later innovation expensive?**

Two things are explicitly *not* in scope here, by the partner's call: license questions
and any public / stranger-facing boundary. (The product vision doc, `docs/AskWRI-Product-Vision-2026-2028.docx`,
already contains an OSS-shaped gate: *"We will not build a platform for other
organizations' corpora until a second WRI-adjacent tenant proves the seams."* This memo
is the work of pricing what "proving the seams" would take; it does not revisit that
gate.)

## 1. Intent and why

Four drivers, all real, none yet bitten:

| # | Driver | Concrete instance |
|---|---|---|
| D1 | A team wants its own AskWRI | Comms: PDFs **and blog posts**, mostly answer mode, own voice and branding |
| D2 | A group wants to share with outsiders | A research group, own research PDFs, partners as readers |
| D3 | We (and others) want to add capability fast | Expert finder, MCP / retrieval API |
| D4 | Some of this should be open, some not | A basic core published, modules not — **decision deferred** |

The partner's position on shape: a foundational core is required, modules optional; the
more likely first scenario is *someone with a corpus runs their own instance*;
tenants are *WRI or WRI-adjacent for the moment*, which means hand-held, with us in the
room; the ambition does include considering a plugin framework and configurability of
the document model.

**Success looks like:** a second WRI-adjacent group runs its own instance over its own
corpus, gets *correct* cited retrieval on that corpus, and the parts we had to touch to
get them there are named and reusable — not a fork that drifts.

## 2. Goals, non-goals, anti-goals

**Goals**
- Name the core/module line and what attaches at it.
- Make calibration and evaluation portable and customizable (partner's explicit call):
  a second tenant must be able to re-derive quality thresholds on its own corpus.
- Make the document model configurable enough for different corpora (see Q1 in §10 on
  exactly what this means).
- Decide, or deliberately defer, every expensive-to-reverse choice.
- Keep the option of a plugin framework open without paying for it yet.

**Non-goals for now**
- Multi-tenancy in one instance (N deployments instead).
- License, packaging, public/stranger-facing OSS boundary.
- Retrieval-quality work, dialogue, or answer synthesis changes.
- A plugin *framework* before there are three consumers of any one seam.

**Anti-goals — this fails even if it technically works**
- A second tenant ships the plausible wrong answer because it inherited WRI-tuned
  thresholds it never re-derived. (Vision doc: *"The enemy is the plausible wrong
  answer."*)
- A plugin framework with one consumer per seam — cost paid, nothing gained.
- A fork that becomes permanent: no upgrade path, drift, and two codebases to maintain.
- A "core" nobody else can run, because deploy, corpus, and calibration stayed outside it.

## 3. As-built constraints a planner must respect

| Concern | Where | Weight |
|---|---|---|
| Web app + admin UI | `src/` (Next.js App Router, TypeORM) | `src/app` 21.2k LOC, `src/db` 6.1k, `src/lib` 2.0k |
| Retrieval | `search-service/app` (FastAPI) | 5.1k LOC, of which `main.py` **2,013 lines**, `app/routers/` is an empty dir |
| Ingestion worker | `search-service/worker` | 3.1k LOC, stages: parse → language → summarize → classify → embed_tags → embed → relate → publish |
| Eval + golden sets | `evaluation/` | 19.8k LOC; judgment data lives in a **separate repo** via submodule `evaluation/eval-review` → `gofenris/askwri-eval-review` |
| Infra | `terraform/` | 2.4k LOC (ECS/ALB/VPC/ECR/service discovery). **RDS is provisioned outside this repo.** |

Hard constraints:
- **`/query` is a frozen contract.** `QueryRequest`/`QueryResponse` in `search-service/app/main.py`
  must be preserved exactly (repo rule). It carries corpus-shaped defaults:
  `max_results: int = 150  # Default for 203-doc corpus`, `required_program` filtering on
  WRI's `program_series`, and `page` as the citation anchor.
- **Write ownership is assigned per table** (app tier owns relational tables; the Python
  side owns `document_chunks`, `document_texts`, `keyword_vocab`, worker-generated
  summaries; two-writer tables have precedence rules; `document_tags` rows with
  `source='human'|'external'` are never modified by the Python side).
- **pgvector columns are not TypeORM-native.** `document_chunks` and `document_texts`
  have no entity; their DDL exists only as raw SQL in migrations.
- **Eval capacity is the binding constraint** (vision doc: *"The binding constraint is
  evaluation capacity… one evaluation lead and one corpus steward"*).
- **Deploy rules:** default branch `qa`; pushing `main` or `production` deploys
  production immediately. This memo's branch is `docs/building-blocks-design`, based on `qa`.
- Local stack exists and works: `scripts/local-bootstrap.sh` + `docker-compose.local.yml`
  (pgvector Postgres + MinIO), 169 lines, idempotent.

## 4. What each driver actually needs

| Driver | What it actually needs | Kind of change | Cost class |
|---|---|---|---|
| D1 Comms | Corpus slice, default mode, branding/voice, **HTML input type** | Config + one new source type + anchor model | Config: small. HTML/anchor: **large, and touches core** |
| D2 Research group | Own corpus in, partners read | Profile + calibration + a read-access story | Medium; scoping is a placeholder today |
| D3 Modules | A client of the existing `/query` contract + data already stored | New caller, new endpoint | Small for MCP; medium for expert finder |
| D4 OSS split | A boundary decision + hygiene on a proven core | Not architecture | Decision, deferrable |

**The reframe that matters:** two different things are being called "modules."

- **Providers** you swap: source adapter, parser, embedder, reranker, LLM. Mechanical;
  needs interfaces. This is what an outsider adopting a core actually swaps. The repo
  already does this — `retrieval_backend` (legacy|postgres), `keyword_backend`
  (sparse|memory), `parse_backend` (`_parse_pdf_pypdf` | Mistral OCR) are two
  implementations behind one env string.
- **Capabilities** you add: dossier, cite-check, expert finder, standing briefs, MCP.
  Needs an API boundary, not an interface. Every one of the vision doc's six capabilities
  is this kind.

Conflating them makes "core + modules" feel like a framework project. It is two smaller
projects with different interfaces.

And a related asymmetry: **modularity is what we want; calibration is what they need.**
Modularity lets us serve variation cheaply. Calibration is what keeps a second tenant
from shipping silently wrong answers on its own corpus. The second is load-bearing for
the promise; the first is an efficiency.

## 5. The corpus contract as it stands today

This is the first interface a replicator meets, and it is currently undocumented as a
contract. A tenant's corpus must satisfy:

- `documents`: `external_id` (unique), `s3_key`, `content_hash` (dedup), `title_en`,
  `date_published`/`year_published`, `publication_title`, `article_type`,
  **`wri_primary_office`**, `status` (`draft` → published lifecycle), `source_metadata`
  jsonb, `extraction_confidence`
- `document_texts` (raw SQL): full text plus `page_boundaries jsonb` — the anchor substrate
- `document_chunks` (raw SQL): `vector` (dense, model-dimension-specific) and `sparsevec`
- `keyword_vocab` (raw SQL): sparse keyword lexicon
- `document_summaries`, `tags` + `tag_aliases` + `document_tags` (with `source` precedence),
  `collections` + `document_collections` (carrying `language_policy` and
  `embedding_model_version` per collection), `ingestion_jobs`, `audit_log`, `users`

Corpus-shaped assumptions already in the code, each of which silently mis-serves a
different corpus:
- Tuned gates: `cite_logit_floor 0.09`, `cite_strong_threshold 0.70`,
  `cite_partial_threshold 0.30`
- Tuned presets in `src/config/retrieval.ts` with sweep comments
  (*"203-doc corpus — 500 is ample coverage"*, *"Re-derived 2026-07-23…"*)
- `query_translation_languages = "es,pt,zh"`; `required_program`; `wri_primary_office`
- WRI vocabulary import lane: `scripts/convert-wri-keywords-csv.ts`, `seed-tag-aliases.ts`
- English-only instruction hardcoded in `src/config/alignment.ts`, alongside a
  translation config that says otherwise
- `intake_s3.py` globs `*.pdf` and skips any key not ending `.pdf`

## 6. Approaches

Each: what it is, what it buys, what it costs, what it forecloses. Sizes are
order-of-magnitude from LOC/file counts, **not** from a build, and every one of them
should be re-based by the spikes in §9.

### A. Deployment profile (config-only, N deployments)
One codebase, one branch, N deployments distinguished by config: branding, default mode,
corpus slice, corpus-tuned thresholds.
**Buys:** cheapest possible tenant #2; no architecture at all; proves which variation is
genuinely data. **Costs:** S — one profile layer (the user-visible WRI strings in the
chrome are only ~11 occurrences, concentrated in `layout.tsx`, `SiteFooter`, `Landing`);
corpus slice needs a filter or a collection; thresholds need somewhere per-tenant to live
(today they are env + `config.py` defaults). **Forecloses:** nothing. **Prerequisite for
every other option** — you cannot design a module boundary you have not observed a
second tenant cross.

### B. Fork per tenant, with an upgrade runbook
**Buys:** zero design work; absolute tenant freedom; fast. **Costs:** the permanent tax —
every upstream commit becomes a merge decision, and the fork silently diverges on
thresholds and prompts. **Forecloses:** nothing architecturally, but it degrades the
mainline's ability to learn from the tenant. **Worth doing once, deliberately, as a
measuring instrument** (see S5): the merge pain *is* the readout on where the seams
belong.

### C. Provider plugin interfaces
Formalize what already exists: source adapters (PDF/HTML/…), parser, embedder, reranker,
LLM, and the stores. Selection stays env-driven; the interface becomes documented and
versioned.
**Buys:** the thing outsiders most want to swap; makes a body of provider assumptions
explicit; cheap because two-implementation seams already exist. **Costs:** S–M to
formalize the ones that exist; a *new source type* (HTML) is not just an adapter — see G.
**Forecloses:** nothing. **Watch:** the interfaces are currently *named* for one format
(`_parse_pdf_pypdf`, `_parse_pdf_mistral`), so formalizing means renaming and dispatching
on source type rather than assuming PDF.

### D. Capability modules over a published boundary
New surfaces as separate callers/services of the core: MCP / retrieval API, expert finder,
dossier, cite-check.
**Buys:** the vision doc's whole H2/H3 capability list, with no core surgery. **Costs:**
S for MCP (`/query` already exists and is contract-frozen — a server is a thin adapter);
M for expert finder (data exists in author metadata + `audit_log`, but it needs an
endpoint, a UI surface, and a privacy model — the vision doc makes public listing
opt-in). **Forecloses:** nothing. **Note:** this is the cheapest place to start D3, and
it does not need a plugin framework — it needs a stable HTTP contract, which exists.

### E. Core extraction — and the boundary you cut at
Three boundaries are already in use and they do not line up:

1. **HTTP:** the `/query` contract (frozen; carries corpus defaults).
2. **The Postgres schema:** the web app reads and writes the DB directly (63 files under
   `src/db`), and the worker writes it too. The schema, not HTTP, is the real boundary today.
3. **Repo topology:** judgment data already lives outside the code repo (`eval-review` submodule).

So "extract a core" means choosing a cut:
- **Schema-cut:** core = retrieval service + worker + migrations + local stack; clients
  read the DB. **Buys:** cheap, and matches how the system already works (two writers,
  documented ownership rules). **Costs:** S–M, mostly documentation, a corpus-schema
  contract, secrets/deploy story. **Risk:** the schema becomes a public interface with
  no versioning discipline.
- **HTTP-cut:** the app stops touching the DB; read APIs are published for catalog,
  summaries, tags, collections. **Buys:** a clean, technology-neutral boundary; the app
  becomes the first module. **Costs:** M–L (the 63-file `src/db` surface, plus contract
  versioning and N+1/perf work). **Forecloses:** the cheap path — once published, the API
  is a promise.

### F. Full plugin framework
Entry-point registry, lifecycle, versioning, discovery, per-module config namespaces.
**Buys:** genuinely third-party modules; the ambition as stated. **Costs:** L up front
plus a permanent tax on every change to the core, and it is only rational once there are
three or more consumers of one seam. **Forecloses:** cheap refactoring of the core —
every seam becomes a compatibility surface. **Recommendation:** keep the option open
(maintain providers behind interfaces, keep `/query` stable); do not build the framework
until the spikes show three consumers.

### G. Document-model configurability
Two very different halves, and they should not be planned as one:
- **Taxonomy and metadata mapping** — doc types, facets, tag vocabulary, which metadata
  fields exist and where they come from. Today these are WRI's (`article_type`,
  `publication_title`, `wri_primary_office`, `required_program`, WRI keyword CSVs).
  **Costs:** S–M as configuration. Faces nothing hard.
- **The citation anchor.** `page` is the unit of citation and it is baked into
  `document_texts.page_boundaries`, `Passage.page: Optional[int]` in the frozen contract,
  cite mode's page-anchored offsets, and the UI. Blog posts have no pages. **This is the
  one change that reaches the core**, and the deeper version — a claim as the unit of
  retrieval (vision doc §4) — is the same generalization. **Costs:** M–L; the UI
  assumption count is unmeasured and is the memo's biggest unknown. **Forecloses:**
  keeping the contract frozen: generalizing anchors means relaxing the repo rule
  "preserve `/query` exactly," which is a decision for the product owner, not a module.

### H. Calibration and evaluation as a portable module
Extract the corpus-dependent quality work into something a tenant can run on their own
documents: a golden-set/eval-set format, a threshold re-derivation run, a report that
says "these defaults are yours now."
**Buys:** the actual promise ("correct on your corpus"), and it is the module with real
external consumers. **Costs:** M — the raw material exists (`evaluation/calibrate-cite-thresholds.ts`,
sweeps, golden-set generation, review UI) but is welded to WRI's corpus, and
`eval-review` already proves the data-lives-elsewhere shape works. **Note:** its interface
is *data*, not code — which makes it the cheapest module to publish and the one most
worth publishing. **Forecloses:** nothing.

### I. Single-instance tenancy (name it, defer it)
Organizations/workspaces, per-tenant row scoping, per-partner visibility inside one
deployment. **Buys:** shared upgrades, one corpus, cross-tenant analytics. **Costs:**
L–XL, and it would touch every query path and the frozen contract. **Status today:**
grep finds no tenant/org/workspace concept anywhere; auth is one install with two roles
(`admin`, `editor`); `collections.visibility` is written and **never read** — a
placeholder someone left for exactly this. **Defer** unless D2's partners must share one
instance; N deployments cover D1 and D2.

## 7. Reversibility ledger — the anti-corner work

The partner's constraint is "don't paint ourselves into a corner." So classify by cost to
*undo*, not by importance.

| Decision | Cost to undo | Locked by | Action now |
|---|---|---|---|
| Citation anchor = page | **Months** | `Passage.page` (frozen contract), `page_boundaries` DDL, cite-mode offsets, UI | Decide before Comms' blog posts; or make it replaceable behind an anchor abstraction |
| Boundary for the core (schema vs HTTP) | Weeks–months | Whatever gets published; promises to callers | Defer; do not publish yet |
| Calibration portability | Weeks | Nothing — it is additive | Do it early: tenant #2 needs it anyway |
| Provider interfaces | Days–weeks | Nothing | Formalize opportunistically, one seam at a time |
| Plugin framework | Weeks (plus permanent tax) | Every seam it exposes | Defer until 3 consumers |
| Doc-model taxonomy/metadata config | Days | Nothing | Do when tenant #2 asks |
| Tenancy | Months | Query paths, contract | Defer; N deployments |
| OSS / license boundary | Decision only | Nothing technical | Defer per partner |

Two entries above are the real corner risks: **the anchor** (core data model) and
**anything published** (an API or framework seam becomes a compatibility promise). Both
are handled by "decide late, but never *silently* — either abstract it now or fix it
deliberately."

## 8. Recommendation

1. **Tenant #2 first, through approach A**, with the calibration lane (H) alongside it.
   This is the only experiment that produces knowledge about the seams; every other
   approach above is a guess until then.
2. **Make the anchor decision deliberately, before any non-paginated corpus.**
   Either generalize the anchor (contract change, owner's call) or state that the core is
   document-anchored and HTML arrives as a converted document with synthetic structure.
3. **Extract what two tenants share — not what one tenant imagines.** Provider interfaces
   (C) opportunistically; capability modules (D) as thin callers of the frozen contract.
4. **Keep the plugin framework as an open option, not a deliverable**: providers behind
   interfaces, `/query` stable, per-tenant config in one place.
5. **Defer tenancy, boundary, and OSS packaging** — all reversible, all currently
   speculative.

**What would change this recommendation:** if a second tenant must live inside one
instance (then §6-I moves onto the critical path and the contract changes anyway); or if
a stranger-facing OSS release becomes a commitment inside 12 months (then the HTTP-cut
and the packaging work must start now, and the anchor must be generalized first).

## 9. Spike plan

Cheap experiments that turn guesses into evidence. Each has a kill criterion.

| # | Spike | Method | Cost | Proves / falsifies |
|---|---|---|---|---|
| S1 | Config-only second deployment | Stand up tenant #2 with a sliced corpus, different branding, answer-mode default. No code refactor. Log every file touched. | Days | Which variation is really config. Kills "we need a plugin framework" fast if the touched-file list is ~zero |
| S2 | Calibration portability | Re-derive cite thresholds on a small second corpus using the existing harness; compare to WRI defaults. | Days | Whether inherited thresholds actually mis-serve a different corpus — i.e., whether H is load-bearing or nice-to-have |
| S3 | Non-PDF ingest + anchor feasibility | Take 20 blog posts end-to-end; count UI and contract surfaces that assume pages. | Days–weeks | Sizes the anchor decision. Falsifies "HTML is just a source adapter" |
| S4 | Provider swap | Swap one provider (parser or embedder) end-to-end behind the existing env seam; write down what leaked. | Days | Whether the existing env-switch pattern generalizes into an interface without a framework |
| S5 | Fork drift | Fork one tenant's instance, run it for 5 upstream commits, measure merge pain. | Days | The true cost of approach B, and the readout on where seams should be |

Sequencing: S1 and S2 in parallel; S3 before any commitment to a non-paginated corpus;
S4 and S5 opportunistic.

## 10. Open questions — the product owner's to answer

**Q1. What does "docs configurability" mean?** Two readings: (a) the *document model* is
configurable — doc types, metadata mapping, facets, anchors; (b) the *deployment
documentation* is configurable/templated for tenants. This memo assumes (a) and treats it
as §6-G. If (b), it is a docs-writing task and drops out of the architecture entirely.

**Q2. Must D2's partners read from one instance, or is a separate deployment acceptable?**
If one instance, tenancy (§6-I) is on the critical path and several conclusions here
change.

**Q3. Who runs calibration for a tenant — us as a service, or them with our tooling?**
A tool is a module (H). A service is an operating commitment (staffing).

**Q4. Is the blog-post corpus (D1) a real commitment or an illustration?** It is the only
driver that forces the page-anchor decision now.

**Q5. Is relaxing "preserve `/query` exactly" acceptable if the anchor must generalize?**
That rule is written into `CLAUDE.md`.

## 11. Left to the builder

Not decisions above; implementation freedom: provider interface shapes and naming, how
per-tenant config is stored and loaded, the calibration module's file/workflow format,
the MCP server's surface, the expert finder's privacy model, migration ordering, test
strategy, and how each spike is instrumented. Also deliberately unspecified: module
packaging mechanics and repository layout, which wait on §8's boundary decision.
