# Phase 1 Recon Notes — Codebase Facts for the Implementation Plan

> Recovered output of the Explore recon agent launched 2026-06-10 (session
> `b422175a`, suspended before results returned). Verbatim findings below;
> input to the Phase 1 (ingestion + classification) implementation plan.
> Verify file/line references before relying on them — they reflect the tree
> at commit `d3ce4fa` on `qa`.

## 1. Terraform ECS Patterns

### ECR repos — `terraform/infrastructure/ecr.tf`

Two repos, named by convention `${project_name}-${environment}` and `${project_name}-${environment}-search-service`:

```hcl
# ecr.tf:5-20
resource "aws_ecr_repository" "app" {
  name                 = "${var.project_name}-${var.environment}"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration   { encryption_type = "AES256" }
}

# ecr.tf:64-79
resource "aws_ecr_repository" "search_service" {
  name                 = "${var.project_name}-${var.environment}-search-service"
  image_tag_mutability = "MUTABLE"
  ...
}
```

Image URIs inside task definitions always reference `${aws_ecr_repository.<name>.repository_url}:latest`. The `:latest` tag is overwritten by every push; SHA tags are also pushed but the task def pins to `latest`.

### Search-service task definition (representative — use this as the worker template)

Full resource at `terraform/infrastructure/ecs.tf:503-669`:

```hcl
resource "aws_ecs_task_definition" "search_service" {
  family                   = "${var.project_name}-${var.environment}-search-service"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.search_service_container_cpu
  memory                   = var.search_service_container_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  volume { name = "tmp" }
  volume { name = "ssm-agent" }

  container_definitions = jsonencode([
    {
      name      = "init-volumes"
      image     = "${aws_ecr_repository.search_service.repository_url}:latest"
      essential = false
      user      = "0"
      command   = ["sh", "-c", "mkdir -p /tmp/askWRI_docs /tmp/askWRI_cache/hf_hub && chown -R 1000:1000 /tmp"]
      mountPoints = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      logConfiguration = { logDriver = "awslogs", options = { "awslogs-group" = ..., "awslogs-stream-prefix" = "ecs-init" } }
    },
    {
      name  = "${var.project_name}-${var.environment}-search-service"
      image = "${aws_ecr_repository.search_service.repository_url}:latest"
      readonlyRootFilesystem = true
      privileged             = false
      dependsOn = [{ containerName = "init-volumes", condition = "SUCCESS" }]
      mountPoints = [
        { sourceVolume = "tmp",       containerPath = "/tmp",               readOnly = false },
        { sourceVolume = "ssm-agent", containerPath = "/var/lib/amazon/ssm", readOnly = false }
      ]
      portMappings = [{ containerPort = var.search_service_container_port, hostPort = var.search_service_container_port, protocol = "tcp" }]
      environment = concat(
        [ {name="ENVIRONMENT", value=var.environment}, {name="PORT", ...}, {name="NEXTJS_BACKEND_URL", ...},
          {name="DOCUMENTS_S3_BUCKET", ...}, {name="DOCUMENTS_S3_PREFIX", ...}, {name="CACHE_S3_PREFIX", ...},
          {name="HF_HUB_CACHE", value="/tmp/askWRI_cache/hf_hub"} ],
        [ for key, value in var.search_service_environment_variables : { name=key, value=value } ],
        [ for key, value in try(jsondecode(var.search_service_secret_env), {}) : { name=key, value=value } ]
      )
      logConfiguration = { logDriver = "awslogs", options = { "awslogs-stream-prefix" = "ecs" } }
      essential = true
    }
  ])
}
```

### Search-service ECS service (`ecs.tf:675-711`)

```hcl
resource "aws_ecs_service" "search_service" {
  name                    = "${var.project_name}-${var.environment}-search-service"
  cluster                 = aws_ecs_cluster.main.id
  task_definition         = aws_ecs_task_definition.search_service.arn
  desired_count           = var.search_service_desired_count
  launch_type             = "FARGATE"
  enable_execute_command  = true

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.search_service.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.search_service.arn
  }

  deployment_circuit_breaker { enable = true, rollback = true }
  lifecycle { ignore_changes = [desired_count] }
  # NOTE: no load_balancer block — search-service is internal only
}
```

The search-service has **no ALB attachment** — only service discovery (`search-service.${project_name}-${environment}.local`). A worker service needs the same: no `load_balancer` block, no `depends_on` ALB listener, and no target group.

### IAM roles (`ecs.tf:47-173`)

Both existing services share the same two roles:
- `aws_iam_role.ecs_task_execution` — standard `AmazonECSTaskExecutionRolePolicy` attachment; needed to pull ECR images and write CloudWatch logs.
- `aws_iam_role.ecs_task` — the task role with:
  - SSM Exec permissions (`ssmmessages:*`) at `ecs.tf:99-118`
  - S3 permissions for `DOCUMENTS_S3_BUCKET` — `s3:ListBucket`, `s3:GetObject/GetObjectVersion` on `${documents_s3_prefix}*` and `${cache_s3_prefix}*`, plus `s3:GetObject/HeadObject/PutObject` on `eval-data/*` (`ecs.tf:121-173`, conditional on `var.documents_s3_bucket != ""`).

A worker service can reuse both roles as-is (the S3 policy already covers the prefixes the worker will read).

### Service discovery (`ecs.tf:717-771`)

DNS namespace: `${project_name}-${environment}.local`

```hcl
# ecs.tf:727-748
resource "aws_service_discovery_service" "nextjs" {
  name = "nextjs"
  dns_config { namespace_id = ..., dns_records { ttl=10, type="A" }, routing_policy="MULTIVALUE" }
}

resource "aws_service_discovery_service" "search_service" {
  name = "search-service"
  ...
}
```

A worker DNS entry would be `ingestion-worker.${project_name}-${environment}.local` but since the worker only needs to reach Postgres and the other services (not be reached), a service discovery entry is optional.

### Security groups (`security_groups.tf`)

- `aws_security_group.ecs` — ingress only from ALB on `var.container_port`. `ecs.tf:48-72`
- `aws_security_group.search_service` — ingress from ALB + from `aws_security_group.ecs` on `var.search_service_container_port`. `security_groups.tf:78-112`
- Worker SG pattern: ingress from nothing (pure egress worker); egress open `0.0.0.0/0` for S3/Postgres/OpenAI HTTPS. Also needs ingress rule on the RDS SG (like `aws_security_group_rule.rds_from_ecs` at `security_groups.tf:118-128`).

### Files that must be touched to add a third service

| File | What to add |
|---|---|
| `terraform/infrastructure/ecr.tf` | `aws_ecr_repository.ingestion_worker` + `aws_ecr_lifecycle_policy.ingestion_worker` |
| `terraform/infrastructure/ecs.tf` | `aws_cloudwatch_log_group.ingestion_worker`, `aws_ecs_task_definition.ingestion_worker`, `aws_ecs_service.ingestion_worker`, optionally `aws_appautoscaling_target.ingestion_worker` |
| `terraform/infrastructure/variables.tf` | `ingestion_worker_container_cpu/memory/desired_count/min/max_capacity`, `ingestion_worker_environment_variables`, `ingestion_worker_secret_env` |
| `terraform/infrastructure/security_groups.tf` | `aws_security_group.ingestion_worker` (no ingress needed), `aws_security_group_rule.rds_from_worker` |
| `terraform/infrastructure/ecs.tf` (service discovery, optional) | `aws_service_discovery_service.ingestion_worker` if other services need to call it |
| `.github/workflows/deploy-production.yml` | New `build-and-push-ingestion-worker` job; add to `deploy-service` `force-new-deployment` and `wait services-stable` |
| `.github/workflows/deploy-qa.yml` | Same pattern |

### Deploy mechanism (`deploy-production.yml`)

Four jobs chained: `test` → `build-and-push` + `build-and-push-search-service` (parallel) → `deploy-infrastructure` (runs `terraform apply -var-file`) → `deploy-service` (runs `aws ecs update-service --force-new-deployment` for both services, then `aws ecs wait services-stable`).

Env vars injected via two GitHub Secrets as JSON strings: `TF_VAR_askwri_app_secret_env` and `TF_VAR_search_service_secret_env` — decoded inside the task definition with `try(jsondecode(var.search_service_secret_env), {})` at `ecs.tf:636-639`.

No deploy scripts in a `scripts/` directory — workflow is entirely in `.github/workflows/`.

## 2. S3 Usage in the App Tier

Three files use `@aws-sdk/client-s3`:

**`src/lib/eval-storage.ts:1-17`** — the only runtime S3 client in the app tier:

```typescript
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const BUCKET = process.env.DOCUMENTS_S3_BUCKET || '';
const PREFIX = process.env.EVAL_S3_PREFIX || 'eval-data/';

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({});  // credentials from task role (IRSA/instance profile)
  }
  return s3Client;
}
```

Bucket/prefix env vars: `DOCUMENTS_S3_BUCKET` and `EVAL_S3_PREFIX` (hardcoded default `eval-data/`). The app task definition also passes `DOCUMENTS_S3_PREFIX` and `CACHE_S3_PREFIX` (`ecs.tf:337-343`) but those are used only by the search-service for S3-sync; the Next.js tier only uses `eval-data/`.

**`evaluation/upload-eval-to-s3.ts:9,16-17`** — CLI script, not a runtime module:

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
const BUCKET = process.env.DOCUMENTS_S3_BUCKET;
const PREFIX = process.env.EVAL_S3_PREFIX || 'eval-data/';
const client = new S3Client({});
```

**`evaluation/download-eval-from-s3.ts:7,11-12`** — CLI script:

```typescript
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
const BUCKET = process.env.DOCUMENTS_S3_BUCKET;
const PREFIX = process.env.EVAL_S3_PREFIX || 'eval-data/';
```

All three construct `new S3Client({})` with no explicit region/credentials — relies on the ambient AWS environment (ECS task role / local `~/.aws`).

## 3. LLM Call Patterns — `/api/alignment/route.ts`

**Client construction** (`alignment/route.ts:29-51`): No SDK client object — uses raw `fetch` to `${BASE_URL}/chat/completions`.

```typescript
// route.ts:22-51
const MODEL = (
  process.env.OPENAI_MODEL_ALIGNMENT ??
  process.env.OPENAI_MODEL ??
  CFG_MODEL ??
  'gpt-5-mini'
).trim()
const IS_GPT5 = /^gpt-5/i.test(MODEL)
const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
```

**Core call function** (`alignment/route.ts:238-328`):

```typescript
async function chatOnce(apiKey: string, body: any, ms: number, variant: string) {
  res = await fetchWithTimeout(
    `${BASE_URL}/chat/completions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    ms,
  )
  // ... parse tool_calls or content, return { ok, status, durationMs, content, parsed, finishReason, usage }
}
```

**Structured output / JSON mode** (`alignment/route.ts:431-568`): Three-variant waterfall:

1. `response_format: { type: 'json_schema', json_schema: ALIGNMENT_SCHEMA }` — first attempt
2. `tools: TOOL_DEF, tool_choice: { type: 'function', function: { name: 'set_assessment' } }` — fallback if json_schema fails or returns 4xx
3. `response_format: { type: 'json_object' }` — final repair attempt

**GPT-5 param routing** (`alignment/route.ts:331-337`):

```typescript
function applyCap(body: any, cap: number) {
  if (IS_GPT5) body.max_completion_tokens = cap
  else body.max_tokens = cap
}
function maybeTemperature(body: any) {
  if (!IS_GPT5 && Number.isFinite(TEMPERATURE)) body.temperature = TEMPERATURE
}
```

**Error handling**: `withAbort(ms)` wraps every call with `AbortController`; the outer `POST` handler catches all errors and always returns `200` with `ok: true` and a deterministic fallback `Assessment`.

**Env vars across all LLM routes**:
- `OPENAI_API_KEY` — universal
- `OPENAI_BASE_URL` — optional override (defaults to `https://api.openai.com/v1`)
- `OPENAI_MODEL` — base default
- `OPENAI_MODEL_ALIGNMENT` / `OPENAI_MODEL_WHY` / `OPENAI_MODEL_RELATES` — per-route overrides
- `OPENAI_MAX_TOKENS`, `OPENAI_TEMPERATURE` — shared caps/temperature
- `OPENAI_MODEL_NANO` — used in `/api/answer` for a cheaper model pass

## 4. Dockerfiles

**`Dockerfile`** (repo root) — Next.js app (multi-stage, `node:24-alpine`):
- Builder stage: `npm ci` + `next build`
- Runner stage: installs `aws-cli` (for S3 sync), copies `.next/standalone`, runs as `nextjs` (UID 1001), CMD is `./start-app.sh`
- Hardened: `readonlyRootFilesystem` is handled at ECS level; image pre-creates `/tmp/askWRI_docs` and `/app/.next/cache`

**`search-service/Dockerfile`** — Python FastAPI service.

There are exactly two Dockerfiles in the repo. No docker-compose file found.

## 5. Language Detection / NLP Dependencies

**`search-service/requirements.txt`** — No `langdetect`, `fasttext`, `lingua`, `opencc`, `spacy`, `nltk`, `polyglot`, `langid`, `cld2`, `cld3`, or any language-detection library is present. NLP stack is limited to: `sentence-transformers`, `rank-bm25`, `llama-index-retrievers-bm25`, `onnxruntime`/`optimum` for cross-encoder reranking, `pandas`, `numpy`.

**`package.json`** — no NLP or language-detection packages.

Confirmed: no language-detection deps exist anywhere in the repo.

## 6. `/api/llamaindex` Route

`src/app/api/llamaindex/route.ts` is a **pure proxy** to the search-service. It does not call any LLM.

```typescript
// route.ts:4-6
const SEARCH_SERVICE_URL =
  process.env.SEARCH_SERVICE_URL || 'http://localhost:8000'
```

The `POST` handler:
1. Accepts `{ query, mode, alpha, denseTopK, sparseTopK, rerankTopK, retrievalMode, ...options }`
2. Merges client params with preset defaults from `@/config/retrieval` (`CITE_PRESET` / `ANSWER_PRESET`)
3. Calls `fetch(`${SEARCH_SERVICE_URL}/query`, ...)` — `route.ts:107-113`
4. Maps the search-service response into the app's standard doc shape (normalising scores to `[0,1]`, extracting metadata fields)
5. Returns `{ ok, docs, sources, usage: null, debug: { llamaindex: true, ... } }`

`GET` handler: proxies `GET ${SEARCH_SERVICE_URL}/health` for a health check.

## 7. Job/Queue-Like Patterns — Confirmed Absent

**`src/` TypeScript** — the only hit for `setInterval`/`cron`/`worker`/`queue`/`polling` in `src/` was:
- `src/db/migrations/1781280000000-Migration.ts:141` — the `ingestion_jobs` table DDL uses `DEFAULT 'queued'` as a column literal string. No runtime polling or job-dispatch code exists.

**`search-service/` Python** — grep for scheduler/cron/loop patterns returned:
- `search-service/app/config.py:14` — `workers: int = 1` (uvicorn worker count config)
- `search-service/app/main.py:256` — `concurrent.futures.ThreadPoolExecutor(max_workers=2)` inside a single request handler (parallel S3 sync)
- `search-service/app/main.py:1265` — `uvicorn.run(..., workers=settings.workers ...)` — process count for uvicorn

None of these are background loops, cron jobs, or queue consumers. The search-service is a pure request-response FastAPI service driven by uvicorn. No `celery`, `apscheduler`, `asyncio.sleep` loops, or `while True` polling exists anywhere in the repo.

**Key fact for the plan**: the `ingestion_jobs` table schema already exists in the database (migration `1781280000000`) with columns `id`, `document_id`, `stage`, `status` (default `'queued'`), `error`, `attempts`, `model_versions`, `created_at`, `updated_at`, and index `idx_ingestion_jobs_status`. The worker will be the first consumer of this table.
