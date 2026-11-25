# AskWRI: change a PDF parser and rebuild the corpus

Audience: a system administrator who has not operated AskWRI before.  
Source review: 25 November 2026. This document describes repository behavior, not a fresh inspection of live AWS settings.

## 1. Start here

A parser turns a source PDF into text with page locations. A parser migration is complete only after the affected PDFs have been parsed again, their chunks and embeddings rebuilt, the keyword index refreshed, and search/citations checked.

**Current readiness:** Mistral and native pypdf are integrated into ingestion. OpenAI, Sonnet and Docling were evaluated offline; those evaluation runners are not production ingestion adapters. Do not set `PARSE_BACKEND=openai`, `claude` or `docling` on the current code: only `mistral` is explicitly dispatched, and other values fall through to pypdf.

**Important correction:** the current pipeline writes into the configured database and replaces each document's chunks in place. It does not implement a versioned parallel index, automatic corpus-wide cutover, or one-command rollback. The separate rebuild described below requires engineering preparation. Do not assume changing a model setting creates a second index.

Use this procedure in this order:

1. Obtain the engineering handoff in section 4.
2. Record the baseline and recovery point.
3. Test four short PDFs, one source-verified document per language.
4. Rebuild an isolated corpus in bounded batches.
5. Validate extraction, retrieval and citations.
6. Release the verified corpus using the production release procedure.

If the engineering handoff is incomplete, sections 2–3 and the read-only checks are still usable. Stop before deploying a new backend or queuing a migration. This is a technical prerequisite, not an extra permission request.

## 2. Understand the system

| Component | Purpose | Repository location |
|---|---|---|
| Web application / admin | Upload PDFs, manage documents, request re-ingestion, search UI | `src/` |
| Ingestion worker | Processes queued documents, calls parsers/models, writes derived data | `search-service/worker/` |
| Search service | Dense and keyword retrieval, reranking, passage context | `search-service/app/` |
| PostgreSQL / pgvector | Documents, extracted text, chunks, vectors, queues and vocabulary | Database configured for each environment |
| S3 | Original PDFs and derived artifacts | Environment-specific bucket/prefix settings |
| ECS Fargate | Runs the application, search service and ingestion worker | `terraform/` |

QA is the test deployment at <https://qa.askwri-app.org>. Production serves users. An isolated migration environment must have its **own writable database, queue, worker, search service and derived-artifact destination**. A second worker pointed at QA's database is not isolation. Sharing original source PDFs read-only can be appropriate; sharing writable intake/queue/cache destinations needs an explicit engineering design.

The ingestion sequence is:

```text
parse -> language -> summarize -> classify -> embed -> publish
```

The `embed` stage performs both chunking and dense embedding; there is no separate `chunk` stage. It also writes per-chunk sparse keyword vectors. A later bulk keyword rebuild refreshes corpus-wide statistics.

### Terms used below

- **Backend:** parser implementation, currently `mistral` or `pypdf`.
- **Model:** provider's model ID; prefer an immutable version when available.
- **Chunk:** a searchable passage taken from extracted text or a summary.
- **Embedding:** numerical representation of a chunk used by dense retrieval.
- **Sparse index:** keyword vectors, vocabulary and corpus statistics.
- **Canary:** a small real end-to-end test before processing the corpus.
- **Re-ingest:** enqueue a document from the beginning of the pipeline.
- **Reindex:** reload search-service state. This does **not** parse PDFs again.

## 3. Prerequisites and environment safety

Obtain these from the system owner before starting:

- Repository checkout and deployed release SHA; access to the QA admin UI.
- AWS identity with the specific read/deploy/execute permissions assigned to your role, and a database access path. Use the organization's existing sign-in process.
- Organizational parser access, plus the existing embedding and worker-LLM access. Parser access alone does not cover downstream calls.
- A named database operator responsible for backups/restores, and a release owner.
- An agreed page budget and cloud-charge limit. Estimate parser, summary/classification and embedding charges, not just parser charges.
- A protected location for the migration record and evidence. Do not put credentials in it.

For workstation commands, install Git, the AWS CLI, PostgreSQL `psql`, and the repository's supported Node/Python dependencies. Initial local setup is documented in [Local testing](local-testing.md). Local bootstrap creates local resources; it is not an isolated AWS migration environment and does not prove cloud model access.

Start in the repository root. On the original evaluation workstation this is:

```bash
cd /Users/davidgutelius/dev/askwrimvp
```

Use the actual clone path on another machine. Check the branch and your AWS account:

```bash
git status --short --branch
aws sts get-caller-identity --query '{Account:Account,Arn:Arn}' --output json
```

Expected: the intended working branch and organization AWS account. Account/role identifiers are internal metadata; redact them before external sharing.

**Release trap:** code pushes to `qa` deploy QA. Code pushes to `main` or `production` can immediately deploy production. Never use `main` as a staging branch. Production changes follow [Production release](production-release.md), start to finish. This runbook does not replace that release procedure.

### Credentials

Prefer provider calls inside the approved AWS runtime so credentials stay there. Never print an entire ECS environment, call `printenv`, enable shell tracing, or save keys in screenshots, logs, scripts or reports. Follow the repository's secret-handling rules in [CLAUDE.md](../../CLAUDE.md#secret-safety).

`with-remote-env.sh` supplies **database connection settings only**. It is not a provider-credential loader. Running a worker locally through it does not automatically provide parser, OpenAI or Bedrock access.

Bedrock access to one model does not imply access to another model, inference profile or region. Textract has separate permissions. The November evaluation's direct Sonnet 5.5 calls were denied; do not treat the personally authenticated Claude Code test as an organizational deployment solution.

## 4. Engineering handoff: required before the administrator starts writes

Have the implementing engineer complete this table. Blank entries block the corresponding operation.

| Required item | What the administrator needs |
|---|---|
| Supported adapter | Deployed code SHA; accepted backend name; exact model; prompt and output limits; retry, timeout, concurrency and incomplete-output behavior |
| Output contract | Full text plus original PDF page boundaries, including empty pages; split-file page rebasing; no silent summary/paraphrase fallback |
| Cache identity | Backend/model plus any prompt/settings/adapter-policy revision that changes emitted text; test proving an upgrade misses the old cache |
| Organizational access | Runtime role/credential reference, allowed models/profiles/regions, successful bounded test; no actual keys in this table |
| Isolated environment | Database identity, queue, source read path, derived-artifact destinations, task/service names, search URL and admin URL; proof they are isolated |
| Exact operator commands | Tested task/runner image, command, working directory, document-ID input, concurrency limit, monitoring and stop/resume procedure |
| Preservation | Document IDs, source hashes, lifecycle state, collections, human/external metadata, tags and summaries retained according to precedence rules |
| Baseline/recovery | Snapshot or restore point ID, restoration rehearsal, previous task definitions/image digests and non-secret settings |
| Cutover/rollback | Tested data release procedure, search reload steps, recovery commands, who executes them and expected recovery time |
| Acceptance | Fixed queries/relevance judgments, citation checks, extraction checks, allowed regressions and spending limits |

For a parser-only change, freeze the embedding model, chunking parameters, keyword analysis/English-handle flag, fusion, reranking, query set and judgments. Changed parsed text will still change chunks and vectors. Do not combine an embedding-model migration with this operation unless separately designed and assessed.

If retaining Mistral and changing only its model, the adapter may already be sufficient. Still verify the cache stamp, deploy settings, canary and full rebuild. A mutable `mistral-ocr-latest` alias can change without changing the cache identity.

The current Docker image copies `app/` and `worker/`, **not `scripts/`**. Commands such as `python -m scripts.reingest_all` or `python -m scripts.build_sparse_keyword` will not work in that image merely because ECS Exec is available. Engineering must supply a tested runner containing the scripts, or an equivalent reviewed execution procedure. Do not improvise a production runner from a personal laptop.

## 5. Record the baseline and recovery point

Create a migration record using section 12. Record the UTC start time, environment, intended documents and budget. Exclude withdrawn documents. Documents without retrievable PDFs require separate accounting; title/summary fallback is not a successful PDF parse.

The following query file is read-only and contains no provider calls:

```bash
./scripts/with-remote-env.sh qa psql -X -v ON_ERROR_STOP=1 \
  -f docs/runbooks/sql/pdf-parser-migration-checks.sql
```

Expected: database identity, document/queue counts, parser stamps, missing-text/vector checks and keyword-statistics counts. The helper prints its target database first. Stop if it resolves to the wrong environment. Save the output in the protected migration record. This targets **QA**, not a newly created isolated environment. For the latter use the connection command supplied in section 4; the helper accepts only `qa` and `production`.

Record the current worker task definition and image without displaying its environment:

```bash
aws ecs describe-services --region us-east-2 \
  --cluster askwri-app-qa-cluster \
  --services askwri-app-qa-ingestion-worker \
  --query 'services[].{Service:serviceName,TaskDefinition:taskDefinition,Desired:desiredCount,Running:runningCount}'

aws ecs describe-task-definition --region us-east-2 \
  --task-definition askwri-app-qa-ingestion-worker \
  --query 'taskDefinition.{TaskDefinition:taskDefinitionArn,Containers:containerDefinitions[].{Name:name,Image:image}}'
```

The family lookup shows the latest registered task definition; it may differ from the service's active revision. Inspect the exact revision returned by `describe-services` as well, and verify running-task image digests using the release runbook. A green deployment or ECS “stable” state alone does not prove the intended worker image is running.

Before any in-place write, the database operator must capture a consistent recovery point and prove it can be restored. Include related corpus/queue/keyword tables and any changed S3 artifacts, not just vectors. The existing [corpus fingerprint tool](../../scripts/fingerprint-corpus.sh) can record content checksums; it is **not a backup**.

## 6. Deploy configuration and run a short canary

Use four **short** source-verified PDFs: English, Chinese, Spanish and Portuguese. Prefer roughly 2–5 pages each where available; record actual lengths before spending. Include at least one table or labeled figure and one multi-column page. Inspect the source itself: the earlier manifest's Spanish/Portuguese starter filenames contained English translations.

1. Engineering deploys the supported adapter/settings to the isolated environment. Confirm the running image, backend and model match section 4. Restarting a task on an old task definition does not install the new adapter.
2. Verify parser, embedding and worker-LLM access with the bounded canary, using the supplied runtime. Do not paste provider keys into terminal commands.
3. In that environment's admin UI, open **Documents**, select a canary document and record its UUID from the detail URL and its pre-run status.
4. Choose **Re-ingest** on the document detail page. Repeat only for the four canaries. Record each job ID if returned by the API or visible in the admin tooling.
5. Monitor the queue and worker logs (section 8). Confirm each document reached `parse` through `publish`, not merely a cache hit or successful enqueue.
6. Compare source pages to text and search/citations. Record numbers, units, table relationships, reading order, captions, footnotes, omitted material and original page numbers. Inspect truncation, duplication and paraphrasing in generative output.

A successful job is not a quality score. `extraction_confidence` is a heuristic based on density, language and chunk presence, not an accuracy measure.

### What should change during re-ingestion?

- Parse cache: text is reused only when source hash, backend and model stamp match and `FORCE_REPARSE` is false. A different backend/model should trigger a miss if integration is correct.
- `FORCE_REPARSE=true`: bypasses cache in the **worker that executes parse**. Setting it only on an enqueue command does not affect an already-running worker. Use it only when needed; restore false afterward.
- Language detection runs again; verify bilingual covers did not cause the wrong document language.
- Generated summaries and LLM metadata/tags can refresh; human/external values are protected by source precedence. Collections and IDs should remain intact. Confirm rather than manually deleting protected rows.
- Embed rebuilds chunks, dense vectors and incremental sparse vectors. Old chunks are replaced per document in the configured database.
- A previously searchable document may be restored to searchable if its quality gate passes. It can disappear from search while processing, and failures can leave it in review/error. New documents wait for admin promotion. This is why a live in-place rebuild is not a zero-downtime migration.

## 7. Rebuild the isolated corpus in bounded batches

Proceed only when the four canaries pass the agreed checks.

Export an explicit manifest of UUIDs, external IDs, source hashes, page counts, original statuses and languages. Choose batch sizes by **page count**, not just document count. Preserve an account of exclusions, duplicates, unsupported files and missing PDFs. Snapshot the manifest; do not keep expanding it during the run.

The repository's enqueue tool supports explicit UUIDs. This is a **write command**, shown for an engineering-supplied runtime with the correct database and provider configuration:

```bash
# Working directory: search-service, in the supplied isolated runtime.
# Replace both placeholder UUIDs with this batch's actual document UUIDs.
python -m scripts.reingest_all --ids 'DOCUMENT_UUID_1,DOCUMENT_UUID_2'
```

The UUID is the database document ID, not a filename, external ID or fixture suffix such as `1319`. If using a verified repository virtual environment instead, the executable is `./venv/bin/python` from `search-service/`.

**Always supply `--ids`.** Omitting it selects every non-withdrawn document, including documents that are not currently searchable. The tool has no dry-run switch. Its logged count is the number of selected documents, not proof of completed jobs or new queue rows. Existing open jobs are not duplicated and may already be past parse under old settings; resolve these before starting the migration batch.

Start with a small batch. Wait for it to finish, inspect failures and spend, then submit the next batch. Log each batch's job IDs and source hashes. Do not start additional workers without checking rate limits and stale-job timeouts. Retries and reaped jobs can repeat provider calls.

Do not run `reembed_cohere.py` as a substitute: it updates dense vectors for existing chunks but does not parse PDFs or rebuild chunks. Likewise `POST /reindex` does not perform this migration.

## 8. Monitor, stop and resume

For QA, worker logs are in CloudWatch under `/ecs/askwri-app-qa-ingestion-worker`. Use the isolated environment's actual log group from section 4. Avoid exporting unredacted error logs to public artifacts.

Run the read-only SQL checks again using the same explicit connection as section 5. Inspect `ingestion_jobs.status`, `stage`, `attempts`, `error` and `updated_at`, filtered to the recorded batch IDs/job IDs. In a queued job, `stage` usually names the **last completed** stage; a null stage starts at parse. For failed/review jobs, the stage identifies where the worker recorded the problem. Historical jobs must not be mistaken for this run.

Expected progression: queued/running jobs eventually become `done` or a documented review/error case. No missing batch documents and no silently substituted parser are acceptable.

Stop submitting batches if any of these occur:

- Wrong database, image, backend/model or source hash.
- Repeated provider denial, truncation, empty/missing pages or incorrect citations.
- Unexpected disappearance of previously searchable documents or protected-data changes.
- Repeated throttling/reaping, unresolved errors, or the agreed charge limit is reached.

Use the stop procedure supplied with the runner. Pause all migration consumers and intake as specified there; scaling one ECS service to zero does not stop other consumers, queued jobs or already-running external calls. Do not delete queue rows or kill a worker in the middle of a database write as a routine pause method.

After fixing the cause, retry one affected document first. Normal retry resumes after recorded completed stages; it may not repeat parse. A fresh re-ingest is needed when the extraction itself must change. Do not manually edit stages/statuses to force progress. Record recovered failures and repeat charges.

## 9. Refresh keyword statistics and search state

After the bulk rebuild, drain the migration jobs and stop **all ingestion writers** to the target database. Prevent automatic intake from creating new work while the refresh runs. Record the previous worker counts so they can be restored.

Run this write command in the supplied runner that contains `scripts/`, pointed at the **rebuilt database**:

```bash
# Same runtime/configuration as the rebuild; no ingestion writers active.
python -m scripts.build_sparse_keyword
```

Keep `SPARSE_EN_HANDLES` and other lexical settings identical to the worker/search configuration. Do not guess or silently toggle the flag. The script rebuilds vocabulary/statistics and sparse vectors for chunks across document statuses; it is not a parser call or dense re-embedding pass. Its writes commit atomically, but it must not race worker writes.

Expected: successful completion, populated sparse vectors for searchable chunks, and `keyword_corpus_stats.n_chunks` matching the rebuilt chunk count across all statuses. Re-run the SQL checks. Explain any discrepancy before continuing.

Reload the target search service using the exact command/endpoint in the engineering handoff. `/reindex` is a search-state refresh, not a second parse; a best-effort publish-stage refresh is not sufficient evidence that the whole new corpus is loaded. Verify successful initialization in service logs and the actual retrieval lanes. HTTP 200 alone can conceal degraded/fallback behavior.

## 10. Acceptance and production release

The administrator collects evidence; the corpus/search owner reviews content quality.

| Gate | Required evidence |
|---|---|
| Coverage | Every manifest document accounted for; source hashes unchanged; no missing/empty pages without documented source-based explanation |
| Extraction | Source-versus-output checks across all four languages, tables/figures, units/numbers, notes, order and omissions; independent human review where possible |
| Provenance | Original PDF page references still resolve to the correct evidence; split pages and Chinese normalization do not shift citations |
| Data | Expected parser stamps on PDF-derived rows; valid boundaries; current dense model/dimensions; keyword vectors/statistics complete |
| Preservation | IDs, statuses, collections and protected human/external values reconcile with baseline; no withdrawn documents republished |
| Search | Fixed baseline/candidate queries and judgments; dense and keyword lanes plus reranker verified; citation correctness and agreed relevance measures reported separately from extraction |
| Operations | No unresolved migration jobs; charges and retries reconciled; running images verified; restore procedure rehearsed |

Do not invent Recall/nDCG from extraction scores. Do not approve solely on matching document/chunk counts or the parser bakeoff's eight reference pages.

Production promotion follows [Production release](production-release.md), including the pending-operations checks, data mirror dry run, fingerprints, actual running-image verification and rollback. That procedure normally mirrors QA's verified finished corpus into production rather than re-ingesting production. If the rebuild is in a third environment, it must first be transferred into QA using an engineering-supplied, verified procedure; the existing mirror is not a generic arbitrary-environment cutover.

An isolated build does not itself guarantee uninterrupted cutover. If zero downtime is required, engineering must provide and test the data/search cutover mechanism; do not infer it from the existence of two databases. Record the release window and any expected search interruption.

## 11. Rollback

**Before production release:** stop the isolated migration and retain its evidence. The original serving environment should be unchanged. Fix the issue and repeat the canary.

**After an in-place rebuild or data release:** changing `PARSE_BACKEND` back does not restore old text, chunks, vectors, summaries or keyword data. Rolling back code alone is insufficient.

The database/release operators must execute the recorded recovery procedure:

1. Stop affected ingestion/intake writers and control user writes as required by the restore plan.
2. Restore the consistent pre-migration corpus/database and affected artifacts, or switch to a preserved verified environment if an engineered switch exists.
3. Restore the matching application/worker/search images and settings.
4. Reload search state; repeat fingerprints, queue, lifecycle, dense/sparse and citation checks.
5. Resume traffic and workers only after validation. Account for writes since the recovery point; a whole-database restore can discard later admin/user changes.

If no recoverable baseline exists, old-parser re-ingestion is a new paid rebuild with downtime/risk, not a quick rollback. This is why the recovery point is mandatory before in-place migration.

## 12. Migration record template

Copy this into the protected change record. Never include provider/database keys.

```text
Migration ID / operator / UTC start and finish:
Environment and database identity:
Source commit / running image digests / task definitions:
Old parser backend/model/policy -> new backend/model/policy:
Embedding model, chunking, lexical flag, fusion/reranking (frozen):
Original source manifest location / hash / docs / total pages:
Included statuses / exclusions and reasons:
Canary PDFs / verified languages / pages / observations:
Reference annotations / reviewer / measured versus unavailable metrics:
Backup/restore point / rehearsal / recovery owner and time:
Batch manifest -> job IDs -> outcomes / attempts / spend:
Per-document cache-hit/miss and parser-stamp verification:
Protected metadata/tag/summary/collection reconciliation:
Sparse rebuild log / counts / settings:
Search reload and lane-health evidence:
Fixed queries / judgments / retrieval and citation results:
Estimated versus billed costs / retries / unresolved items:
Release owner / decision / production verification:
Rollback commands, baseline identity and result if used:
```

## 13. Troubleshooting

| Symptom | What to check / action |
|---|---|
| Re-ingest completes but old text remains | Cache hit; worker still has old backend/model; mutable alias unchanged; wrong task definition. Verify stamps and executing runtime. |
| `ModuleNotFoundError: scripts` | Current deployed Docker image does not ship the scripts. Use the prepared runner; do not assume ECS Exec installs them. |
| Parser access denied | Exact runtime role, provider, model/profile and region; refer to cloud administrator. Do not substitute a different model silently. |
| Parse succeeds, embedding fails | Independent embedding access/quota, model and vector dimension. Parser authorization is not embedding authorization. |
| Job `done`, document `needs_review` | New-document promotion may be pending. Review the source and lifecycle; do not mass-promote to hide failures. |
| Formerly searchable doc stays unavailable | Review/error state, wrong prior status, incomplete stages or quality gate. Compare baseline and job history. |
| Keywords regress after bulk work | Missing sparse rebuild, mismatched English-handle flag or stale corpus statistics. |
| `/health` or deployment is green but results are old | Inspect actual task/image digests, boot logs, active database and search-state reload. |
| Two “successful” runs differ | Confirm exact source hashes, immutable model IDs, prompts/settings, cache identity and service defaults. |

## 14. Source references

- [Configuration](../../search-service/app/config.py): actual settings/defaults.
- [Parse/cache contract](../../search-service/worker/stages/parse.py): dispatcher, page boundaries, cache stamps and metadata extraction.
- [Pipeline stages](../../search-service/worker/stages/__init__.py), [worker](../../search-service/worker/main.py), [queue](../../search-service/worker/queue.py).
- [Summaries](../../search-service/worker/stages/summarize.py), [chunking/embedding](../../search-service/worker/stages/embed.py), [publish lifecycle](../../search-service/worker/stages/publish.py).
- [Scoped enqueue tool](../../search-service/scripts/reingest_all.py), [sparse rebuild](../../search-service/scripts/build_sparse_keyword.py), [Docker image contents](../../search-service/Dockerfile).
- [Database access helper](../../scripts/with-remote-env.sh), [production release](production-release.md), [document management](../document-management.md).
- [Private parser evaluation](https://wri-parser-evaluation-lab.bouncychess17.chatgpt.site): measured extraction evidence, not an implemented migration or retrieval benchmark.
