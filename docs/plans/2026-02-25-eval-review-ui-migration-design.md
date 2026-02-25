# Evaluation Review UI Migration Design

**Date:** 2026-02-25

## Goal

Move the evaluation review UIs from the standalone server (`evaluation/serve-label-review.ts` on :3001) into the Next.js app so external reviewers can access them on the QA server. Add a view-only cite eval report page. Use S3 for data persistence.

## Architecture

```
Browser → ALB (:80) → Next.js ECS Task (:3000)
                          ├── GET  /api/eval/review-labels        → label review HTML
                          ├── GET  /api/eval/labels               → labels JSON (S3)
                          ├── POST /api/eval/labels/override      → write label override (S3)
                          ├── GET  /api/eval/review-synthesis     → synthesis review HTML
                          ├── GET  /api/eval/synthesis-eval       → synthesis eval JSON (S3)
                          ├── GET  /api/eval/synthesis-raw        → captured passages JSON (S3)
                          ├── POST /api/eval/synthesis-eval/review → write human eval (S3)
                          ├── GET  /api/eval/review-cite          → cite report HTML (view-only)
                          └── GET  /api/eval/cite-report          → cite report JSON (S3)
```

### S3 Layout

Same bucket as documents (`askwri-data`), new prefix:

```
s3://askwri-data/eval-data/
  ├── answer-labels-review.json
  ├── answer-synthesis-eval-final.json
  ├── answer-synthesis-raw.json
  └── cite-report-latest.json
```

### Local Dev Fallback

API routes detect `NODE_ENV !== 'production'` and fall back to local file I/O from `evaluation/`. The standalone review server continues to work for local development.

## Storage Layer

**New module:** `src/lib/eval-storage.ts`

- `readEvalFile(filename): Promise<object | null>` — S3 GetObject in production, fs.readFileSync locally
- `writeEvalFile(filename, data): Promise<void>` — S3 PutObject in production, fs.writeFileSync locally
- `evalFileExists(filename): Promise<boolean>` — S3 HeadObject in production, fs.existsSync locally

**S3 client:** `@aws-sdk/client-s3` (minimal dependency). ECS tasks use IAM role credentials — no API keys needed.

**Env vars:**
- `DOCUMENTS_S3_BUCKET` — existing, reused
- `EVAL_S3_PREFIX` — new, defaults to `eval-data/`

## API Routes

### Label Review (Answer Retrieval)

| Route | Method | Reads/Writes |
|-------|--------|-------------|
| `/api/eval/review-labels` | GET | Serves HTML |
| `/api/eval/labels` | GET | `answer-labels-review.json` |
| `/api/eval/labels/override` | POST | `answer-labels-review.json` |

POST validation: `question_id` and `chunk_id` required, `override` must be one of `relevant`, `partially_relevant`, `not_relevant`.

### Synthesis Review

| Route | Method | Reads/Writes |
|-------|--------|-------------|
| `/api/eval/review-synthesis` | GET | Serves HTML |
| `/api/eval/synthesis-eval` | GET | `answer-synthesis-eval-final.json` |
| `/api/eval/synthesis-raw` | GET | `answer-synthesis-raw.json` |
| `/api/eval/synthesis-eval/review` | POST | `answer-synthesis-eval-final.json` |

POST validation: score values must be numbers 0-1, `reviewed` must be boolean, dimensions must match the 5 expected keys.

### Cite Report (View-Only)

| Route | Method | Reads |
|-------|--------|-------|
| `/api/eval/review-cite` | GET | Serves HTML |
| `/api/eval/cite-report` | GET | `cite-report-latest.json` |

No write endpoints. HTML shows: summary bar (overall precision/recall/pass rate), per-query table with pass/fail badges.

## Frontend

Existing HTML templates from `serve-label-review.ts` are reused with one change: fetch URLs updated from `/api/labels` to `/api/eval/labels` (etc.). No React rewrite.

The cite report page is a new self-contained HTML template following the same pattern.

## Upload/Download Scripts

```bash
npm run eval:upload              # push eval JSON files to S3
npm run eval:upload -- --file answer-labels-review.json
npm run eval:download            # pull reviewed data back locally
```

`eval:upload` also copies the latest `evaluation/results/eval-report-*.json` to S3 as `cite-report-latest.json`.

### End-to-End Workflow

1. Run eval scripts locally (produces JSON files)
2. `npm run eval:upload` → pushes to S3
3. Reviewer opens QA URL (e.g., `http://<qa-alb>/api/eval/review-synthesis`)
4. Reviews are saved to S3 via POST routes
5. `npm run eval:download` → pulls reviewed data back locally
6. `npm run eval:synthesis-assemble` → builds golden dataset

## Terraform Changes

Add `s3:PutObject` to existing `ecs_task_s3` policy, scoped to eval prefix:

```hcl
{
  Sid    = "PutEvalObjects"
  Effect = "Allow"
  Action = ["s3:PutObject"]
  Resource = "arn:aws:s3:::${var.documents_s3_bucket}/eval-data/*"
}
```

Add `EVAL_S3_PREFIX` env var to Next.js container definition.

## Access Control

Open access — same as the rest of the QA app. The QA URL is not publicly advertised.

## Concurrency

Single reviewer at a time. Simple read-modify-write to S3. No locking needed.

## Documentation

- Update `evaluation/README.md`: add upload/download commands, QA reviewer access section, file structure updates
- This design doc
