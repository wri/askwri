# Local Dev Environment — Full-Fidelity AskWRI Without AWS (Design)

**Date:** 2026-07-06  ·  **Branch:** `qa-wip-david`  ·  **Status:** approved design, pre-implementation
**Companions:** [local-testing.md](../runbooks/local-testing.md) (current manual guide this supersedes-in-part),
[phase0-cutover.md](../runbooks/phase0-cutover.md) (the setup steps this automates),
[next-steps-qa-deploy.md](2026-07-02-next-steps-qa-deploy.md) (the deploy this de-risks).

## Goal

Run the complete document-management stack — web app, search service, ingestion worker — on a
laptop in the **same modes QA will run** (`RETRIEVAL_BACKEND=postgres`, `KEYWORD_BACKEND=sparse`,
`CATALOG_SOURCE=postgres`, S3-backed PDF handling), with **zero AWS access**, brought up by **one
idempotent command**, without touching any file the deploy path reads (`.env`, GitHub secrets,
terraform). Purpose: validate the ~104-commit document-management branch end-to-end locally
*before* the sysadmin-gated QA deploy, and keep a fast test loop afterward.

## Verified constraints (all tested on this machine, 2026-07-06)

- **No AWS credentials exist locally** (`aws sts get-caller-identity` fails) and the QA RDS is
  unreachable. The design must need neither. It doesn't.
- **One durable corpus copy:** `search-service/data/` — 169 PDFs, `documents.csv` (169 rows),
  warm cache. `/tmp/askWRI_docs` is only a symlink to it (macOS wipes `/tmp` on reboot;
  the symlink is recreated by the bootstrap).
- **Warm embeddings** live at `cache/indexes/771352c09526844b_vector_index/default__vector_store.json`
  — the migration script's supported fallback (`embeddings.pkl` absent). Worst case on a
  content-hash mismatch it re-embeds misses (~$1, minutes). Not a blocker.
- **`s3_key` scheme:** bare filename (`file_path` or `<external_id>.pdf`). The admin file route
  calls `GetObject(Key: doc.s3Key)` with no prefix; `start-app.sh` syncs with an empty default
  prefix. Local bucket layout must mirror this: bucket `askwri-data`, bare-filename keys,
  `DOCUMENTS_S3_PREFIX` empty.
- **Jest env trap:** `next/jest` runs with `NODE_ENV=test` and Next.js *skips `.env.local` in
  test mode* — DB-backed Jest suites need `.env.test.local` (already gitignored; `.env.test` is not).
- **boto3 needs no code change** for MinIO (honors `AWS_ENDPOINT_URL`, auto path-style). The
  Node SDK does: `new S3Client({})` at 3 call sites, and SDK v3 has no env var for
  `forcePathStyle`.
- Ready on this machine: docker compose v5, port 5432 free (other pg container is on 5435),
  `pgvector/pgvector:pg16` image pulled, venv healthy (Python 3.13.2), OpenAI key valid,
  173 GB disk. Node is v23.10 vs `engines >=24` — unenforced and working; note-only.

## Design

### 1. `docker-compose.local.yml` — two services, nothing else

- **`askwri-pg`**: `pgvector/pgvector:pg16`, user/password `askwri`/`password`, db `qa`,
  port 5432. Values match `phase0-cutover.md` and the URL hardcoded in `npm run test:db`.
- **`askwri-minio`**: MinIO, API :9000, console :9001, static dummy creds
  (`local-askwri` / `local-askwri-secret`).
- No init containers; all seeding lives in the bootstrap script (§3). Named volumes so data
  survives container recreation.

### 2. Env convention — gitignored `.env.local` overrides; `.env` untouched

`.env` keeps the QA-RDS values it has today and stays the deploy-day reference. Local overrides
live in files Next.js already prefers and git already ignores:

- **Root `.env.local`**: local `DB_*`, `SESSION_SECRET` (32+ chars), `CATALOG_SOURCE=postgres`,
  `AWS_ENDPOINT_URL=http://localhost:9000`, dummy `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`,
  `DOCUMENTS_S3_BUCKET=askwri-data`, `DOCUMENTS_S3_PREFIX=` (empty).
- **Root `.env.test.local`**: the same DB vars, for `next/jest` (see trap above).
- **`search-service/.env.local`**: `DATABASE_URL` (local), `RETRIEVAL_BACKEND=postgres`,
  `AWS_ENDPOINT_URL`, bucket vars, intake S3 prefix. **`INTAKE_LOCAL_DIR` must not be set** —
  its presence silently switches the worker to the local-dir intake path and defeats the
  S3-fidelity test.

Three small code changes make every entry point honor the convention (each inert in prod,
where none of these files exist):

1. **pydantic-settings** (`search-service/app/config.py`): `env_file=(".env", ".env.local")` —
   later file wins; real env vars still win over both.
2. **TypeORM/seed scripts** (`package.json` `typeorm`/`seed:admin`): replace `-r dotenv/config`
   with a ~5-line preload that loads `.env.local` then `.env`. dotenv never overrides real env,
   so deploy-day `DATABASE_URL=… npm run migration:run` behaves exactly as today.
3. **`src/lib/s3.ts`** (~10 lines): returns `S3Client` config — if `AWS_ENDPOINT_URL` is set,
   `{ endpoint, forcePathStyle: true }`; else `{}`. Used by the 3 existing `new S3Client({})`
   call sites (admin intake, admin file, eval-storage). No separate force-path-style variable.

Rejected alternative: a zero-code-change wrapper script (`./scripts/dev <cmd>`) — avoids the
three edits but taxes every command ever run; the convention costs ~20 lines once.

### 3. `scripts/local-bootstrap.sh` — one idempotent command

Every step checks state before acting; safe to re-run after reboot, docker wipe, or new worktree.
Fails loudly (with the specific remedy) on: incomplete corpus, occupied ports, unhealthy
containers, missing venv.

1. **Preflight:** corpus check (169 PDFs, `documents.csv`, cache dir present in
   `search-service/data`), venv exists, docker up, ports 5432/9000 free-or-ours.
2. **Symlink:** recreate `/tmp/askWRI_docs → search-service/data` (public PDF route and
   admin local fallback both read it).
3. `docker compose -f docker-compose.local.yml up -d` + wait for pg/minio health.
4. **Env files:** write the three env files from heredoc templates *only if absent* (never
   overwrite user edits).
5. **Migrations:** `npm run migration:run` (local `.env.local` via the preload). The
   destructive `178130` is a no-op on a fresh local DB.
6. **Corpus:** skip if `documents` count is already 169; else
   `migrate_csv_to_postgres` (warm cache; **never `--reset`** — the D6 footgun).
7. **Sparse backfill:** `build_sparse_keyword` (idempotent; skip if
   `keyword_corpus_stats` is populated and fresh).
8. **MinIO seed:** create bucket `askwri-data` and upload the 169 PDFs at bare-filename keys +
   ensure empty `intake/` prefix (one-shot `minio/mc` container).
9. **Admin user:** `npm run seed:admin -- admin admin-local-password` (skip if exists is fine —
   the script force-resets, which is acceptable for a local account).
10. **Verify + report:** SQL asserts `docs=169, searchable=169, texts=169,
    missing_embeddings=0`, sparse vocab ~184k; prints the three boot commands and the
    health-check curl.

### 4. Validation gate (first run; also the recurring pre-push loop)

Full gate minus long evals, ~30–45 min, a few cents of OpenAI:

- Suites: `npm test` (incl. DB suites via `.env.test.local`), `npm run test:db`,
  `npm run test:python`, `npm run lint`, `npx next build --webpack`.
- **`docker build` both images** (app + search-service; build-only). Native processes can't
  catch Dockerfile bugs and B1 — the worker crash-loop — was exactly that class.
- Boot all three processes; `/health` must show `retrieval_backend: postgres`,
  `keyword_backend: sparse`.
- Retrieval: sparse parity check (26/26 score-identical), non-English smoke set.
- Worker e2e **through MinIO intake** (one PDF): upload via admin intake UI → S3 branch →
  worker sweep → published, both vector lanes populated, findable via `/query`.
- Admin smoke: login, documents, review queue, withdraw/restore lifecycle (immediate,
  no reindex), audit row appears, **Open PDF via the S3 branch** (MinIO).
- Public: search UI, `/api/pdf/<filename>` serves from the symlinked folder and 404s
  withdrawn docs.

The 70-min `eval:baseline-suite` stays available but is not part of the gate.

### 5. Documentation updates

`docs/runbooks/local-testing.md`: new "Bootstrap (one command)" section at top; MinIO rows in
the substitutes table; correct two stale claims (admin Open PDF *does* work locally via the
`ADMIN_PDF_LOCAL_DIR` fallback; S3-branch testing now possible via MinIO). Note the Node 24
engines mismatch and the possible one-time ~$1 re-embed as known non-blockers.

## Out of scope / accepted fidelity gaps

Deliberately untestable locally — **exactly the sysadmin ask-list** for deploy day:
RDS pgvector availability + `sslmode=require`/`DATABASE_SSL` behavior, IAM/task-role policies
(the B2 bug class), Secrets-Manager JSON→env plumbing (`INGESTION_WORKER_ENV`,
`ASKWRI_APP_ENV` — a malformed secret still crash-loops only at deploy), ECS service wiring,
and the Terraform deploy itself.

Also out of scope: LocalStack, containerizing the three app processes (native = faster
iteration), retrieval tuning, and any change to the `/query` request/response contract.

## Known follow-up surfaced by this design (product finding, not this work)

**Boot-only S3 sync gap:** `start-app.sh` syncs PDFs once at container boot. A document the
worker publishes *after* app boot gets working search and admin Open PDF, but its **public**
PDF link 404s until the app container restarts. Cousin of R1; add to the follow-ups list in
[next-steps-qa-deploy.md](2026-07-02-next-steps-qa-deploy.md) and confirm prod behavior on
deploy day.
