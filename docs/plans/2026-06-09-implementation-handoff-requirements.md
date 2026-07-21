# Implementation Handoff — What an Agent Needs to Write the Tech Spec & Plan

**Date:** 2026-06-09
**Companion to:** `2026-06-09-askwri-document-management-design.md`
**Purpose:** Enumerate the additional context and specs required to hand the comprehensive design to an implementation agent. Flags what can be produced now vs. what needs a human decision.

## 0. What the agent already inherits (no work needed)

Confirmed in the repo: TypeORM is fully wired (`src/db/data-source.ts`, `migration-data-source.ts`, `migration:generate/run/revert` scripts, an existing migrations chain); a consistent API pattern (Next.js route handlers → `src/db/queries/*`); `pg`, `@aws-sdk/client-s3`, `openai`, `uuid`, `reflect-metadata` present; the WRI design system (`@worldresources/wri-design-systems`) and Chakra available for the admin UI; Jest + a mature evaluation harness. The Python `search-service` builds/runs via documented scripts. **The agent should follow these existing conventions, not invent new ones.**

## 1. Repo orientation file (produce now — highest value)

There is **no `CLAUDE.md`/`AGENTS.md`**. An agent needs one. It should capture: the stack and versions, the three-service topology, where each concern lives, build/test/lint/migration commands, the API-route + db-query convention, the TypeORM custom-type requirement (below), deployment substrate (ECS/Terraform), env-var catalog, and "out of scope = retrieval tuning + eval internals." This is the single most useful artifact for agent throughput.

## 2. Interface & contract specs (produce now)

The design names these but an implementation spec needs concrete signatures and types:

- **Provider interfaces** — TypeScript and Python definitions for `EmbeddingProvider`, `SparseProvider`, `RerankProvider`, `ParserProvider`: method signatures, input/output types, error/timeout semantics, model+dimension reporting, batch contracts.
- **Admin API surface** — the endpoint list with request/response DTOs: documents CRUD, upload/import, dedup/version resolution, tag review (accept/edit/reject), typed attributes, collections CRUD + membership + bulk ops, ingestion-job status, export. Follow the existing `route.ts` + query-module pattern.
- **Ingestion job contract** — the job record shape, stage state machine, idempotency keys, retry/backoff, and how the worker claims jobs (`FOR UPDATE SKIP LOCKED`) vs. SQS.
- **search-service repoint contract** — the current `/query` `QueryRequest`/`QueryResponse` (in `search-service/app/main.py`) is the interface to preserve; spec the change from "rebuild-at-boot from CSV" to "read `document_chunks` from Postgres" so retrieval output is unchanged.
- **TypeORM ↔ pgvector** — `vector`/`sparsevec` are not native TypeORM types; spec custom column types (or raw-SQL migrations) and the `CREATE EXTENSION vector` migration, plus HNSW index DDL. Note write-ownership: relational DDL via TypeORM, chunk/vector *rows* written by the Python worker.

## 3. Data mapping (produce now)

- **CSV → schema field map:** explicit mapping from the real `documents.csv` metadata keys (`Article Title`, `All authors`, `YEAR published`, `Sub-tag`, `languages`, `wri_programs`, `wri_primary_office`, `article_type`, `short_summary`, `summary`, `DOI`, `URL`, …) to `documents`/`works`/`document_attributes`/`tags`. This drives the migration script and removes guesswork.
- **Taxonomy v1 seed:** the distinct values currently present in `wri_programs`, `wri_primary_office`, `Sub-tag`, `article_type` — extractable from the CSV — as the starting controlled vocabulary.

## 4. Human decisions required (blockers — make before/at handoff)

The agent cannot invent these; each should be answered or given an explicit "assume X" default:

1. **Taxonomy v1 content** — facets + allowed values, owned by a domain expert. (Agent can scaffold the mechanism; cannot author the vocabulary.)
2. **Auth & roles** — is AskWRI public/internal/mixed; who can ingest/tag/manage; SSO or app auth for the admin surface. Gates the admin API and whether retrieval-time ACL is ever needed.
3. **RDS specifics** — engine version vs. the pgvector 0.8.0 floor (PG 16.5+/15.9+), and confirmation that `CREATE EXTENSION vector` is permitted (RDS allow-list / parameter group). The instance is external to this repo's Terraform.
4. **Dense embedding model** — either decide, or instruct "wire the provider, default to <X>, leave the bake-off to the eval workstream." Governance to use third-party APIs is cleared.
5. **Layout parser** — hosted (LlamaParse) vs. local (Docling/Marker) default; swappable, so a provisional default is fine.
6. **Non-functional targets** — query latency budget, ingestion throughput / time-to-searchable, expected admin concurrency, corpus ceiling. Needed for acceptance criteria.
7. **Cost guardrails** — budget ceilings for ingest-time LLM/embedding spend and for bulk reprocessing.

## 5. Infrastructure specifics to spec (produce now, with input from #4.3)

- **New ingestion-worker service** — its own ECS service/task def, scaling, and IAM (S3, RDS, model APIs); Terraform module mirroring existing services.
- **GROBID** — a separate Java service; needs its own container/ECS service (or managed host) and a client.
- **Model serving** — where BGE-M3 (sparse) + cross-encoder reranker run (CPU service vs. GPU container; e.g., TEI/Infinity/FlagEmbedding); how the dense provider is called (hosted API vs. self-host).
- **Secrets/env** — catalog new env vars (model keys, GROBID URL, parser key, worker queue config) consistent with the existing `.env.example`.

## 6. Assets the agent needs

- A **representative sample of real PDFs** (a two-column journal article, a long working paper, a table-dense report, one scanned/bad PDF) for extraction development and the optional parser check.
- The **real `documents.csv`** to drive and validate the migration.
- Access to the **golden sets** (already in `evaluation/`) for retrieval-parity validation at cutover.

## 7. Instructions to give the agent

- **Sequencing:** produce a tech spec + implementation plan **per phase (0→3)**, Phase 0 first; do not spec a model-final system — keep provider seams.
- **Definition of done per phase:** migrations + tests + the relevant acceptance criteria from #4.6; Phase 0 gated on retrieval parity against golden sets.
- **Guardrails:** stay within document-management scope; treat retrieval tuning, thresholds, and eval internals as external interfaces; preserve the `/query` contract; one-owner-per-domain on writes; follow existing repo conventions.
- **Test strategy:** unit (providers, mappers), integration (ingestion pipeline end-to-end on the sample PDFs), migration dry-run on a CSV copy, and a parity check harness reusing the eval framework.

## Summary: what to generate now vs. decide

**Producible now (I can draft these):** the orientation file (§1), provider + API + job + repoint + TypeORM-pgvector contracts (§2), CSV→schema map + taxonomy seed (§3), infra module outlines (§5), and the per-phase agent brief (§7).

**Needs a human:** taxonomy v1 content, auth model, RDS version/permissions, NFR targets, cost ceilings, and the sample-PDF/CSV assets (§4, §6) — though most can be unblocked with explicit "assume X" defaults so the agent can proceed and flag where a real decision is pending.
