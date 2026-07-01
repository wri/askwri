# Document Management System — Code Review Findings (2026-07-01)

**Status:** Findings log — uncaptured issues from a 5-way parallel code review of branch
`qa-wip-david` (94 commits, Phases 0–2 of the document management system). Not a plan;
a record so nothing is lost. Pair with
[`2026-06-11-qa-push-summary.md`](2026-06-11-qa-push-summary.md) (known limitations) and
the runbooks under [`docs/runbooks/`](../runbooks/).

**Review method:** 5 parallel reviewers (Phase 0, Phase 1, Phase 2, security-auditor,
cross-cutting correctness/tests) over range `e8e77e8..5be237e`. Every finding below was
re-verified against the code on 2026-07-01 before writing it down; file:line references are
to `qa-wip-david` as checked out.

**Adversarial re-verification (2026-07-01):** a second pass of 7 independent reviewers tried
to refute every finding below by re-reading the current code. None were refuted. Six needed a
correction (folded in below): D3's severity was understated, R3's test-coverage gap was worse
than stated, D7's blast radius is narrower than "unconditional delete" implies, R2 is
currently dormant as deployed, R4's failure mechanism was mis-described, and P2's "undocumented
deviation" framing was too strong.

**How this doc is organized:**
1. [Deploy blockers](#1-deploy-blockers) — fix before `git push origin qa`.
2. [New findings — not documented anywhere else](#2-new-findings-not-documented-elsewhere).
3. [Doc bugs — existing docs contradict the code](#3-doc-bugs--existing-docs-contradict-the-code).
4. [Retracted false positive](#4-retracted-false-positive).
5. [Already documented — do not duplicate](#5-already-documented---do-not-duplicate).

---

## 1. Deploy blockers

These block a safe first QA deploy. None were captured in the runbook or qa-push-summary.

### B1 — Ingestion-worker image omits the `worker/` package (worker crash-loops)
- **Where:** `search-service/Dockerfile:55` — `COPY --chown=appuser:appgroup app/ ./app/`
  is the only source-tree COPY; `worker/` is never copied. The worker task runs
  `python -m worker.main` (`terraform/infrastructure/ecs.tf`, `aws_ecs_task_definition.ingestion_worker`).
- **Impact:** `ModuleNotFoundError: No module named 'worker'` → worker crash-loops; no
  intake sweep or ingestion job ever runs. CSV imports create jobs that never process.
  `aws ecs wait services-stable` will fail to reach steady state for the worker.
- **Fix:** add `COPY --chown=appuser:appgroup worker/ ./worker/` to the production stage;
  confirm `worker.main` boots (the `app.config`/`app.db` imports still resolve since `app/`
  is copied).

### B2 — App intake upload to `intake/` is denied by IAM (browser intake 403s in prod)
- **Where:** `src/app/api/admin/intake/route.ts:67` issues `PutObjectCommand({ Key: \`${intakePrefix}${name}\` })`
  to the `intake/` prefix. The shared task role policy `ecs_task_s3`
  (`terraform/infrastructure/ecs.tf:121-188`, `role = aws_iam_role.ecs_task.id`) grants:
  - `WorkerIntakeObjects` (`:165-175`) — `GetObject`+`DeleteObject` on `intake/*`
  - `WorkerPutDocuments` (`:183-186`) — `PutObject` on `documents/*`
  - `PutEvalObjects` — `PutObject` on `eval-data/*`
  - **no `s3:PutObject` on `intake/*` to anyone.**
  `aws_iam_role.ecs_task` is the `task_role_arn` for all three task definitions
  (`ecs.tf:203` app, `:527` search-service, `:844` worker) — it is a shared role.
- **Impact:** browser-based intake upload returns `AccessDenied` (surfaces as 500) in
  prod. Local-dev `INTAKE_LOCAL_DIR` path works, masking it.
- **Fix:** add a `PutObject` statement on
  `arn:aws:s3:::${var.documents_s3_bucket}/${var.intake_s3_prefix}*` to `ecs_task_s3`
  (scoped to the app, or to the shared role if the worker also needs it). Alternative:
  upload directly to `documents/`, but that bypasses the intake→worker→documents flow.

---

## 2. New findings — not documented elsewhere

### 2a. Silent-correctness regressions

**R1 — Public PDF serving breaks at the postgres cutover.**
- `search-service/start.sh:26-27` skips the **entire** S3 sync (documents *and* cache) when
  `RETRIEVAL_BACKEND=postgres`. So `/tmp/askWRI_docs` is empty and
  `src/app/api/pdf/[filename]/route.ts:54` (serves `join("/tmp","askWRI_docs",filename)`)
  404s for every "Open PDF".
- **Confirmed used by the frontend** (the Phase 0 review hedged this; verified 2026-07-01):
  `src/app/utils/utils.tsx:186` (`return fn ? \`/api/pdf/${basename(fn)}\` : doc._url`) —
  results-cite PDF links; `src/app/components/AnswerMode/CitationCard.tsx:206`
  (`href={`api/pdf/${doc.doc_id}.pdf#page=${kp.page || 1}`}`) — answer-mode citations.
- **Fix:** split the `start.sh` condition so the **documents** sync still runs in postgres
  mode (skip only the cache), or serve public PDFs from S3/signed URLs, or — if the route
  is being retired — remove it. Resolve before the prod flip.

**R2 — Worker never calls `setup_ssl_certificates()`.**
- `search-service/app/main.py` calls `setup_ssl_certificates()` at import (the Zscaler VPN
  CA workaround); `search-service/worker/main.py` imports `app.config`/`app.db` but **not**
  `app.main`, so under `USE_CUSTOM_SSL_CLIENT=true` the worker's OpenAI chat, `OpenAIEmbedding`,
  `httpx` (`/reindex`), and `boto3` HTTPS calls use the default CA bundle and may fail SSL
  verification.
- **Fix:** move the SSL setup into a shared module (e.g. `app/ssl.py`) and call it from both
  `app/main.py` and `worker/main.py` at startup, gated on the same env flag. Verify against
  the prod env before treating as live-broken (the one-shot migration script also doesn't
  call it, but the worker is a long-running service, so exposure is greater).
- **Adversarial re-verify (2026-07-01):** confirmed as a latent bug, but currently dormant —
  `USE_CUSTOM_SSL_CLIENT` is not set anywhere in `terraform/` or `.env.example`, so as
  presently deployed the worker never needs the custom CA path. Only bites a local/VPN dev
  environment running the worker standalone with the flag set. Downgrade from "live-broken"
  to "verify before enabling the flag for the worker."

**R3 — Worker `_build_nodes_for_doc` diverges from the Phase-0 `indexing.build_nodes`.**
- `search-service/worker/stages/embed.py:32-39` (`_build_nodes_for_doc`) differs from
  `search-service/app/indexing.py` `build_nodes` in three metadata fields that feed BM25's
  `MetadataMode.EMBED` content:
  1. **title** — worker uses `doc["title"]` (the `documents.title` = `Article Title`
     fallback); migration/legacy use `prepare_documents`' `meta["title"]` = `Publication
     Title` fallback. When `Article Title ≠ Publication Title` the summary-chunk text and
     metadata header differ.
  2. **authors** — worker truncates to 100 chars; `indexing.build_nodes` overwrites the
     Document-level truncated value with the **full** `doc["metadata"]["authors"]` in the
     per-chunk metadata.
  3. **file_path** — worker stores `doc["s3_key"]` (`documents/…pdf`); migration stores
     the CSV `file_path` (`…pdf`).
- **Impact:** the Phase-0 migration itself is byte-identical to legacy (both use
  `indexing.build_nodes`) so the §14.5 parity gate is honest, **but** an admin re-ingest of
  a migrated doc, or any worker-produced doc, produces chunks whose BM25-indexed string
  differs from what the migration would have produced — shifting that doc's keyword rankings.
  No test asserts worker node_metadata matches migration node_metadata.
- **Fix:** have `_build_nodes_for_doc` read title from
  `source_metadata.metadata["Publication Title"]` (matching `prepare_documents`), store full
  authors, and use the same `file_path` convention; or refactor both paths onto one shared
  builder. Add a test pinning worker-output metadata to migration-output metadata.
- **Adversarial re-verify (2026-07-01):** all three sub-claims confirmed exactly as written.
  The gap is worse than stated — there is no test at all for
  `worker/stages/embed.py::_build_nodes_for_doc` (not merely a missing equality assertion
  against migration output; the function has zero coverage).

**R4 — zh OpenCC `t2s` can break page attribution.**
- The embed stage normalizes chunk text to Simplified (`OpenCC("t2s").convert(full_text)`)
  but reuses the **Traditional-text** boundaries for `full_text.find(node.text[:100])` and
  `get_page_number_for_position`. `OpenCC("t2s")` includes the `TSPhrases.txt` phrase
  dictionary, which is **not** guaranteed length-preserving; any length-changing phrase
  shifts every subsequent chunk's computed page number.
- The risk was **flagged High before shipping** in
  `docs/research/2026-06-10-multilingual-retrieval-design-research.md` §1.1 ("silent,
  zh-only"), but shipped as-is. The only zh test
  (`test_zh_normalization_simplified_in_chunks_traditional_in_document_texts`) uses a single
  page boundary and asserts text content, not `page`.
- **Fix:** recompute boundaries on the normalized text (or store both), or run `find()`
  against the original text and use the Simplified form only for chunk content/embedding
  input; add a multi-page zh test asserting `page` values after a length-changing phrase.
- **Adversarial re-verify (2026-07-01):** confirmed, with a mechanism correction. `find()`
  itself does not fail — both the haystack and needle at that call site are consistently
  post-conversion (Simplified) text, so the match succeeds. The actual bug is one step later:
  `get_page_number_for_position(start, boundaries)` compares a post-conversion character
  offset against `boundaries` computed from the pre-conversion (Traditional) text. Any
  length-changing OpenCC phrase before that offset drifts the comparison and can misattribute
  the page. Same silent-wrong-page outcome as described; different root-cause line
  (`get_page_number_for_position`, not `find()`).

### 2b. Data integrity & authz

**D1 — `IngestionJob.entity.ts` `onDelete:'SET NULL'` vs migration `ON DELETE CASCADE`.**
- `src/db/entities/IngestionJob.entity.ts:18` declares `onDelete: 'SET NULL'`; migration
  `1781300000000-Migration.ts:36` (up) set the live FK to `ON DELETE CASCADE` (the down at
  `:46` restores `SET NULL`). Because `synchronize: false`, the DB is correct, but
  `npm run migration:generate` (a documented command in `CLAUDE.md`) diffs the entity
  annotation against the DB and emits a spurious migration reverting the FK to `SET NULL` —
  silently undoing the Phase 1 cascade intent.
- **Fix:** change the `@ManyToOne` `onDelete` to `'CASCADE'` so the entity matches the
  applied schema.

**D2 — Import `OPEN_STATUSES` includes `needs_review` (inconsistent) + read-then-insert race.**
- `src/db/queries/importDocuments.ts:127` — `OPEN_STATUSES = ['queued','running','needs_review']`.
  Both `worker/queue.py::enqueue` and `documentsAdmin.ts::reenqueueIngestion` treat open as
  `queued|running` only ("a parked `needs_review` job does NOT block a fresh drop") and use
  the atomic `ON CONFLICT (document_id) WHERE status IN ('queued','running') DO NOTHING`.
- **Two consequences:** (a) re-importing a parked (`needs_review`) doc won't re-trigger
  ingestion — inconsistent with the worker path; (b) the import does a read-then-insert
  (`:194` `find` then `save`) with no `ON CONFLICT`, so two concurrent imports of the same
  new doc race → the second `save` throws a unique-violation from `178130`'s partial index →
  unhandled `23505` → 500.
- **Fix:** drop `needs_review` from `OPEN_STATUSES`; switch the insert to the same
  `ON CONFLICT … DO NOTHING` atomic pattern used by `reenqueueIngestion`.

**D3 — Unvalidated import `s3_key` → editor cross-prefix S3 reads + worker parse-can't-find-file.**
- `src/db/queries/importDocuments.ts:75` sets `s3Key = row.file_path` with no validation.
  The stored value is then used verbatim by (a) the editor-accessible file download
  (`src/app/api/admin/documents/[id]/file/route.ts:29`, `Key: doc.s3Key` on the S3 branch)
  and (b) the worker parse stage (`search-service/worker/stages/parse.py:32`,
  `Key=doc["s3_key"]`). The task role grants `GetObject` on `documents/*`, `cache/*`,
  `eval-data/*`, and `intake/*`.
- **Security impact — worse than "editor, not admin":** `requireIdentity(req)` is called with
  no role argument on both `/api/import-documents` and `/api/admin/documents/[id]/file`, so
  neither endpoint enforces a role check at all — this is reachable by the lowest
  authenticated tier in the system, not merely an editor-vs-admin distinction. POST
  `/api/import-documents` with `rows:[{file_path:"eval-data/secret.pdf",...}]` creates a
  document row with that `s3_key`; any authenticated user can then either download the raw
  object via `/api/admin/documents/<id>/file`, or let the worker ingest it — and if it parses
  the content becomes `searchable` and can surface to public users through `/query`/the
  answer UI. (Adversarial re-verify, 2026-07-01: confirmed exactly, severity revised upward.)
- **Correctness impact (Phase 1):** the CSV import stores the raw CSV `file_path`
  (e.g. `2021_report.pdf`); the S3 intake stores `documents/2021_report.pdf`
  (`worker/intake_s3.py:39-47`). The parse stage does `s3.get_object(Key=doc["s3_key"])`,
  so a CSV-imported doc whose PDF was uploaded to `documents/<name>.pdf` will miss and fall
  back to title+summary text — silently losing the full PDF for retrieval. Re-ingest via S3
  drop doesn't fix it (the intake `ON CONFLICT DO UPDATE` only updates `content_hash`, not
  `s3_key`).
- **Fix (addresses both):** validate `s3_key` on import (must be a `.pdf` basename under
  `documents_s3_prefix`); construct the S3 GET key from a sanitized basename in the file
  route (the local-path branch already uses `basename(doc.s3Key)` at `file/route.ts:26` —
  the S3 branch does not); normalize `s3_key` to `documents_s3_prefix + <external_id>.pdf`
  in both intake paths.

**D4 — Mutation + audit are not transactional.**
- Every query module does `await repo.save(...)` then `await writeAudit(...)` as separate
  statements (e.g. `documentsAdmin.ts` `updateDocumentFields` ~:141-142, `setDocumentStatus`
  ~:180-181; same shape in `tagsAdmin.ts`, `collectionsAdmin.ts`, `users/[id]/route.ts`).
  If `writeAudit` throws (DB blip, jsonb error, connection drop) the mutation is already
  committed with no audit row — violating the "every mutation writes an `audit_log` row"
  day-one invariant.
- **Fix:** wrap each mutation+audit pair in `AppDataSource.transaction(em => {
  em.save(...); em.getRepository(AuditLog).insert(...) })`.

**D5 — Import audit does not record the actor.**
- `src/db/queries/importDocuments.ts:213` inserts `audit_log` with
  `(source, action, entity_type, after)` — no `actor_user_id`. The route has the identity
  (`src/app/api/import-documents/route.ts:11-13`) but never passes it. Every other mutation
  records who; bulk import does not.
- **Fix:** pass `identity` into `importDocuments` and write `actor_user_id` + `source`
  (`human`/`system`) like the other handlers.

**D6 — `migrate_csv_to_postgres.py --reset` silently `TRUNCATE`s `ingestion_jobs`.**
- `--reset` issues `TRUNCATE documents CASCADE` (and `tags`, `collections`). `CASCADE`
  reaches every table with an FK to `documents`, including `ingestion_jobs` (its FK is
  `ON DELETE SET NULL`, but `TRUNCATE CASCADE` ignores the FK action and truncates
  referencing tables).
- `docs/runbooks/phase0-cutover.md:85` documents that `audit_log` is preserved across
  resets but does **not** mention `ingestion_jobs`. On this branch (Phase 1 worker shipped)
  running `--reset` against a live DB destroys in-flight worker jobs — a data-loss hazard
  for an operation the runbook presents as routine ("re-running after a schema change,
  correcting a migration error").
- **Fix:** `TRUNCATE` only the tables the script owns in steady state
  (`document_chunks`/`document_texts` + the relational tables it seeds) without `CASCADE`
  into `ingestion_jobs`, or document loudly that `--reset` must not be run while the worker
  has live jobs.

**D7 — Migration `178130` destructive DELETE has no code-level guard.**
- `src/db/migrations/1781300000000-Migration.ts:20` `DELETE FROM ingestion_jobs` (the
  pre-unique-index dedupe) is unconditional; the `down` (`:46`) is irreversible (cannot
  restore deleted rows). The runbook (`qa-push-deploy.md:87,236`) documents the quiet-window
  requirement and irreversibility — but the migration itself has no guard (row-count
  assertion, dry-run flag, or confirmation).
- On the first push the table is empty (worker doesn't exist yet), so this is a no-op in
  practice. It becomes a hazard if the migration is ever re-applied against a live system.
- **Fix:** at minimum, assert in `up` that no `status='running'` job is among the
  to-be-deleted set before the DELETE, and/or print the count being deleted.
- **Adversarial re-verify (2026-07-01):** confirmed, but the blast radius is narrower than
  "unconditional DELETE" implies. The DELETE only removes duplicate open jobs per document
  (`rn > 1` in a CTE partitioned per `document_id`, ordered `status='running' DESC,
  created_at DESC`), so a running job is already deprioritized for deletion over a queued
  duplicate in the common case. The unguarded hazard is narrower: it applies when 2+ jobs are
  simultaneously open for one document — most concretely, two simultaneously-`running` jobs
  for the same document, where the older one would be silently deleted with no row-count
  check or guard.

### 2c. Provenance / data-drift

**P1 — `title_en` ships NULL for all 33 migrated non-English docs.**
- `migrate_csv_to_postgres.py` sets `title_en = title if language == "en" else None`, so all
  19 zh + 10 es + 4 pt migrated docs have `title_en IS NULL`. Design §6
  (`2026-06-09-…-design.md`) says `title_en` is "always populated (display/sort convenience)";
  §7.5 says English renditions are generated "all at ingest." The Phase-1 summarize stage
  only sets `title_en = COALESCE(title_en, title)` (native title, not a translation) for docs
  it processes, and migrated docs never run that stage.
- `document-management.md:237` documents the translation deferral but not the migrated-NULL
  gap. No `NOT NULL` constraint, so impact is low (sort falls back to `title`), but it's an
  undocumented deviation from a stated invariant.
- **Fix:** set `title_en = title` for all migrated docs (matching what the summarize stage
  does), or amend the design/as-built to record the deferral explicitly.

**P2 — `bahasa`/`id` mapping diverges between the migration script and the import API.**
- `migrate_csv_to_postgres.py` `LANGUAGE_MAP` is `{english, spanish, portuguese, chinese}`
  (no `bahasa`) → the 2 Bahasa docs default to `language='en'` with a warning (documented in
  `document-management.md §7`). `importDocuments.ts` `LANGUAGE_MAP` adds `bahasa: 'id'`.
  Same file → different `language` provenance depending on which path ingested it.
- **Fix:** reconcile (add `bahasa: 'id'` to the migration script's map, or document why the
  migration intentionally leaves Bahasa to the Phase 1 language-detect stage).
- **Adversarial re-verify (2026-07-01):** divergence confirmed exactly, but "diverges" is
  too strong — `importDocuments.ts` carries an explicit code comment marking `bahasa: 'id'`
  as a deliberate Phase 1 amendment (Indonesian support added after the one-time migration
  script was frozen), and `document-management.md` §7 documents the migration script's
  bahasa→en fallback and warning. It's a real inconsistency in output (same CSV row gets a
  different `language` depending on ingestion path) but it's an intentional, documented
  artifact of Phase 0 being frozen — not an overlooked drift.

### 2d. Test-coverage gaps (the parity claims are stronger than CI proves)

The docs claim "26/26 SQL-vs-bm25s identical," "11/11 cite URL-lists identical," and "instant
withdraw/promote consistency." CI does not enforce any of these.

**T1 — CI only runs `test_sparse_keyword.py` (toy-corpus weight math).**
- `test_sparse_retriever.py` (per-query status filter, NULL-sparse exclusion, `corpus_order`
  tie-break on a seeded DB), `test_worker_pipeline.py`, and `scripts/sparse_parity_check.py --db`
  (the "26/26" check) are **local-only** — `docs/runbooks/phase0-cutover.md:306` lists them
  as "candidates to add." They are scratch-DB-hermetic and self-provisioning (same pattern as
  the CI-included modules), so adding them is cheap.
- `evaluation/run-cite-eval.ts` records `retrieved_urls` per query and computes P/R/F1 but
  asserts **no URL-list equality vs a baseline** — the "11/11 identical" gate is a human
  eyeballing two report JSONs, and the eval is not in CI at all.
- The instant-consistency demo (withdraw→`/query`→absent / restore→present) exists only as a
  manual `psql`+`curl` recipe (`local-testing.md §4`); no automated test drives it.
- **Impact:** a regression in the SQL retriever, `build_sparse_keyword.py`, or `corpus_order`
  order that left the toy math intact would pass CI and silently break the parity the docs
  claim.
- **Fix:** add `test_sparse_retriever.py` + `test_worker_pipeline.py` to the `pr-check.yml`
  pytest selection; add an automated full-corpus SQL-vs-bm25s parity test (or a CI job
  running `sparse_parity_check.py --db` against a migrated scratch corpus); add an assertion
  in `run-cite-eval.ts` (or a wrapper) that fails on URL-list diff vs a committed baseline.

**T2 — `corpus_order` *order* is not pinned by any test.**
- `test_migration_script.py::test_corpus_order_contiguous` asserts only `0..N-1` contiguity,
  not that the order matches `enumerate(build_nodes(...))`. A refactor that sorts
  `documents`, interleaves summary nodes, or changes CSV iteration order passes CI while
  changing BM25 tie-breaks — exactly the failure `document-management.md:26` warns about
  ("Reordering the migration script WILL silently change retrieval tail rankings").
- **Fix:** add a test asserting `corpus_order` agrees with `enumerate(build_nodes(...))` on
  a 2–3-doc synthetic corpus (including "summaries come last, docs in CSV order").

---

## 3. Doc bugs — existing docs contradict the code

These are not "new findings" so much as places an existing doc is actively misleading. Fix
the doc to match the code.

- **`docs/document-management.md §11.1` (JWT/deactivation) understates the protection.**
  It says JWT sessions are "stateless and outlive deactivation by up to the 7-day TTL" and
  "`active` gates new logins only." `src/lib/auth/identity.ts:34-36` re-fetches the user and
  rejects `active===false` on **every** request, re-deriving role from the DB — so
  deactivation takes effect on the next API call (near-immediate), and a stolen cookie is
  revoked by deactivating the user. The code is *more* secure than documented; the same
  stale claim appears in `qa-push-summary.md` "Known limitations." Rewrite §11.1 to state
  deactivation is immediate via DB revalidation; the 7-day TTL is only the hard ceiling if
  the user is never deactivated. **Adversarial re-verify (2026-07-01):** confirmed, with one
  precision nuance — the claim is technically true of the edge layer in isolation
  (`src/proxy.ts` only checks the JWT signature via `verifySession`, no DB call), so §11.1
  should draw that distinction explicitly: edge gate is JWT-only; every actual admin API
  handler underneath calls `getIdentity`/`requireIdentity`, which revalidates against the DB
  and fails closed immediately on deactivation.

- **Runbook `seed-admin` note is wrong.** `docs/runbooks/phase0-cutover.md` says the seed
  script "will not overwrite an existing username." `scripts/seed-admin.ts` resets the
  password, reactivates, and force-promotes to `role='admin'` on an existing user — an
  idempotent reset, not a no-op. It also writes no `audit_log` row (the design says "write
  to `audit_log` from day one") and does not enforce the 12-char minimum the users API
  enforces. Fix the runbook text and either refuse existing non-admin usernames or document
  the escalation; add a length check + audit row.

- **`docs/document-management.md:239` overstates worker-embed parity.** It calls the embed
  stage "Phase 0-identical chunking." Per finding **R3** above, `_build_nodes_for_doc`
  diverges from `indexing.build_nodes` (title source, authors truncation, `file_path` vs
  `s3_key`). Correct the line to "Phase 0-identical *chunking parameters*
  (SimpleNodeParser 400/80, summary node, legacy chunk id, `text-embedding-3-small`); chunk
  *metadata* diverges in title/authors/file_path — see review findings R3."

- **`CLAUDE.md` write-ownership rule is stale.** It states "the Python side owns
  `document_chunks` rows and only those. One owner per domain." The as-built
  (`document-management.md §3`, Scope decision #4) amends this: the worker also writes
  `documents` (intake `draft` rows), `document_texts`, `document_summaries`,
  `document_tags` (`source='llm'`), `ingestion_jobs`, `audit_log`, and `keyword_vocab`.
  So `documents`, `document_tags`, `ingestion_jobs`, and `audit_log` are now two-writer,
  managed by precedence invariants (classify skips `human`/`external`; publish/parse guard
  `status <> 'withdrawn'`). Update `CLAUDE.md` to match Scope decision #4 and document the
  precedence invariants as the actual contract.

---

## 4. Retracted false positive

**I-4 — "`proxy.ts` is not wired; must be `middleware.ts`."** — **RETRACTED.**
The security auditor claimed the edge auth gate is inert because `src/proxy.ts` exports
`proxy`, not `middleware`, and no `src/middleware.ts` exists. This is based on pre-Next-16
convention and is **wrong** for this repo:

- **Next.js 16 renamed `middleware.ts` → `proxy.ts`**; the export must be `proxy` (named or
  default); `middleware` is the **deprecated** name. (Next.js 16 docs, file-convention
  `proxy`; codemod `npx @next/codemod@canary middleware-to-proxy .`.)
- The repo runs Next.js **16.2.4** (`package.json` `"next": "^16.2.4"`).
- `src/proxy.ts:27` exports `async function proxy`, `:55` exports `config` — the correct
  Next 16 convention. No `src/middleware.ts` is expected.
- The Phase 2 plan (`2026-06-10-phase2-admin-ui-implementation-plan.md:46`) documents this
  explicitly: "Next 16 middleware | file is `src/proxy.ts`, must export function named
  `proxy` (or default); `middleware.ts` still works but is the deprecated name."

The defense-in-depth edge gate **is** wired. Mitigations also hold regardless (every admin
API handler calls `requireIdentity`; client `adminFetch` redirects on 401). Verified
2026-07-01 against the Next.js 16 docs. Recorded here so the false positive isn't re-raised.

---

## 5. Already documented — do not duplicate

These were surfaced by the review but are already captured in the qa-push-summary "Known
limitations," the runbook, or a design note. Listed here for completeness; the new *nuance*
(where the review found the documented mitigation/test is missing) is captured in §2.

| Item | Documented where | New nuance (if any) — see §2 |
|---|---|---|
| Plain-text ECS task-def secrets incl. no-expiry `ADMIN_API_TOKEN` (SSM deferred) | qa-push-summary "Known limitations" | — |
| No migration step in CI/CD; no plan-only terraform gate | qa-push-summary; qa-push-deploy.md | — |
| Login rate limit is per-instance (in-memory, resets on deploy) | qa-push-summary | — |
| 3 zh docs with English extracted text (external ids 3778, 5852, 2130) | qa-push-summary; keyword-lane design note §3 | — |
| Frozen sparse-stats drift (IDF/avgdl; new tokens get `df=1`) | keyword-lane design note §5b | — |
| `178130` destructive DELETE + irreversible `down` | qa-push-deploy.md:87,236 | No **code-level** guard → D7 |
| `test_sparse_retriever.py` / `test_worker_pipeline.py` not in CI | phase0-cutover.md:306 | Parity claims not regression-protected → T1 |
| OpenCC `t2s` page-attribution risk | research note §1.1 (flagged High) | Shipped unfixed; no multi-page zh test → R4 |
| `corpus_order` reorder warning | document-management.md:26 | Order not test-enforced → T2 |
| `title_en` translation deferred (COALESCE native title) | document-management.md:237 | Migrated non-EN docs stay NULL → P1 |

---

## Recommended next actions

1. **Fix B1, B2, and R1 before `git push origin qa`.** All three are one-to-few-line fixes
   and unblock a safe first deploy (B1/B2) / prevent a user-visible regression (R1).
2. **Verify R2 against the prod env** (is `USE_CUSTOM_SSL_CLIENT=true` in the worker env?);
   wire `setup_ssl_certificates` into the worker if so.
3. **Capture D1, D2, D3 as a follow-up PR** (entity/`onDelete` fix, import atomicity, `s3_key`
   validation) — D3 is the most important (editor cross-prefix read + public disclosure).
4. **Fix the four doc bugs in §3** in the same PR as their code where applicable.
5. **Add T1 + T2 tests** as a follow-up; until then treat the parity claims as
   operator-verified, not CI-verified.
6. **P1, P2, D4–D7** can track as small follow-ups; none block the first push.
