# Eval Review UI Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move evaluation review UIs into the Next.js app with S3-backed persistence so external reviewers can access them on the QA server.

**Architecture:** New Next.js API routes serve the existing HTML templates and read/write eval data to S3 in production (local files in dev). A new cite report viewer page is added. Upload/download scripts sync data between local and S3.

**Tech Stack:** Next.js App Router API routes, @aws-sdk/client-s3, existing self-contained HTML templates

**Design doc:** `docs/plans/2026-02-25-eval-review-ui-migration-design.md`

---

### Task 1: Install @aws-sdk/client-s3

**Files:**
- Modify: `package.json`

**Step 1: Install the dependency**

Run: `npm install @aws-sdk/client-s3`

**Step 2: Verify it installed**

Run: `npm ls @aws-sdk/client-s3`
Expected: Shows the installed version

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @aws-sdk/client-s3 dependency"
```

---

### Task 2: Create eval storage module

**Files:**
- Create: `src/lib/eval-storage.ts`

**Step 1: Create the storage abstraction**

Create `src/lib/eval-storage.ts` with these exports:

```typescript
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';

const isProduction = process.env.NODE_ENV === 'production';
const BUCKET = process.env.DOCUMENTS_S3_BUCKET || '';
const PREFIX = process.env.EVAL_S3_PREFIX || 'eval-data/';
const EVAL_DIR = path.join(process.cwd(), 'evaluation');

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({});
  }
  return s3Client;
}

export async function readEvalFile(filename: string): Promise<object | null> {
  if (isProduction) {
    try {
      const client = getS3Client();
      const resp = await client.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key: `${PREFIX}${filename}`,
      }));
      const body = await resp.Body?.transformToString('utf-8');
      return body ? JSON.parse(body) : null;
    } catch (err: any) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  const filePath = path.join(EVAL_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export async function writeEvalFile(filename: string, data: object): Promise<void> {
  const jsonStr = JSON.stringify(data, null, 2) + '\n';

  if (isProduction) {
    const client = getS3Client();
    await client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${PREFIX}${filename}`,
      Body: jsonStr,
      ContentType: 'application/json',
    }));
    return;
  }

  const filePath = path.join(EVAL_DIR, filename);
  fs.writeFileSync(filePath, jsonStr, 'utf-8');
}

export async function evalFileExists(filename: string): Promise<boolean> {
  if (isProduction) {
    try {
      const client = getS3Client();
      await client.send(new HeadObjectCommand({
        Bucket: BUCKET,
        Key: `${PREFIX}${filename}`,
      }));
      return true;
    } catch {
      return false;
    }
  }

  return fs.existsSync(path.join(EVAL_DIR, filename));
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit src/lib/eval-storage.ts 2>&1 || echo "Check errors"`

Note: This may show errors about module resolution since it's not a standalone file. That's OK — we'll verify through the route files later.

**Step 3: Commit**

```bash
git add src/lib/eval-storage.ts
git commit -m "feat(eval): add S3/local eval storage abstraction"
```

---

### Task 3: Add label review API routes

**Files:**
- Create: `src/app/api/eval/labels/route.ts`
- Create: `src/app/api/eval/labels/override/route.ts`
- Create: `src/app/api/eval/review-labels/route.ts`

**Step 1: Create GET /api/eval/labels**

Create `src/app/api/eval/labels/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { readEvalFile } from '@/lib/eval-storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const data = await readEvalFile('answer-labels-review.json');
  if (!data) {
    return NextResponse.json(
      { error: 'answer-labels-review.json not found. Run golden-label first.' },
      { status: 404 },
    );
  }
  return NextResponse.json(data);
}
```

**Step 2: Create POST /api/eval/labels/override**

Create `src/app/api/eval/labels/override/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { readEvalFile, writeEvalFile } from '@/lib/eval-storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { question_id: string; chunk_id: string; override: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { question_id, chunk_id, override: overrideVal } = body;
  if (!question_id || !chunk_id) {
    return NextResponse.json({ error: 'Missing question_id or chunk_id' }, { status: 400 });
  }

  const validOverrides = ['relevant', 'partially_relevant', 'not_relevant', null];
  if (!validOverrides.includes(overrideVal)) {
    return NextResponse.json({ error: 'Invalid override value' }, { status: 400 });
  }

  const data = await readEvalFile('answer-labels-review.json') as {
    questions: Array<{
      id: string;
      chunks: Array<{ chunk_id: string; human_override: string | null }>;
    }>;
  } | null;

  if (!data) {
    return NextResponse.json({ error: 'Labels file not found' }, { status: 404 });
  }

  let found = false;
  for (const q of data.questions) {
    if (q.id === question_id) {
      for (const c of q.chunks) {
        if (c.chunk_id === chunk_id) {
          c.human_override = overrideVal;
          found = true;
          break;
        }
      }
      break;
    }
  }

  if (!found) {
    return NextResponse.json({ error: 'Chunk not found' }, { status: 404 });
  }

  await writeEvalFile('answer-labels-review.json', data);
  return NextResponse.json({ ok: true });
}
```

**Step 3: Create GET /api/eval/review-labels (HTML page)**

Create `src/app/api/eval/review-labels/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { REVIEW_HTML } from '@/lib/eval-html-templates';

export const dynamic = 'force-dynamic';

export async function GET() {
  return new NextResponse(REVIEW_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
```

Note: `REVIEW_HTML` will be extracted in Task 6. For now, create this file with an import placeholder.

**Step 4: Commit**

```bash
git add src/app/api/eval/labels/route.ts src/app/api/eval/labels/override/route.ts src/app/api/eval/review-labels/route.ts
git commit -m "feat(eval): add label review API routes"
```

---

### Task 4: Add synthesis review API routes

**Files:**
- Create: `src/app/api/eval/synthesis-eval/route.ts`
- Create: `src/app/api/eval/synthesis-eval/review/route.ts`
- Create: `src/app/api/eval/synthesis-raw/route.ts`
- Create: `src/app/api/eval/review-synthesis/route.ts`

**Step 1: Create GET /api/eval/synthesis-eval**

Create `src/app/api/eval/synthesis-eval/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { readEvalFile } from '@/lib/eval-storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const data = await readEvalFile('answer-synthesis-eval-final.json');
  if (!data) {
    return NextResponse.json(
      { error: 'answer-synthesis-eval-final.json not found. Run stages 1-2 first.' },
      { status: 404 },
    );
  }
  return NextResponse.json(data);
}
```

**Step 2: Create POST /api/eval/synthesis-eval/review**

Create `src/app/api/eval/synthesis-eval/review/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { readEvalFile, writeEvalFile } from '@/lib/eval-storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: {
    test_case_id: string;
    human_eval: {
      scores: Record<string, number>;
      qualitative_feedback: string;
      key_facts_confirmed: string[];
      key_facts_added: string[];
      reviewed: boolean;
    };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.test_case_id || !body.human_eval) {
    return NextResponse.json({ error: 'Missing test_case_id or human_eval' }, { status: 400 });
  }

  const he = body.human_eval;
  const validDims = ['faithfulness', 'completeness', 'conciseness', 'coherence', 'citation_accuracy'];
  if (he.scores) {
    for (const [key, val] of Object.entries(he.scores)) {
      if (!validDims.includes(key) || typeof val !== 'number' || val < 0 || val > 1) {
        return NextResponse.json({ error: `Invalid score: ${key}=${val}` }, { status: 400 });
      }
    }
  }
  if (typeof he.reviewed !== 'boolean') {
    return NextResponse.json({ error: 'reviewed must be a boolean' }, { status: 400 });
  }

  const data = await readEvalFile('answer-synthesis-eval-final.json') as {
    test_cases: Array<{ test_case_id: string; human_eval: any }>;
  } | null;

  if (!data) {
    return NextResponse.json({ error: 'Eval file not found' }, { status: 404 });
  }

  const tc = data.test_cases.find(t => t.test_case_id === body.test_case_id);
  if (!tc) {
    return NextResponse.json({ error: 'Test case not found' }, { status: 404 });
  }

  tc.human_eval = body.human_eval;
  await writeEvalFile('answer-synthesis-eval-final.json', data);
  return NextResponse.json({ ok: true });
}
```

**Step 3: Create GET /api/eval/synthesis-raw**

Create `src/app/api/eval/synthesis-raw/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { readEvalFile } from '@/lib/eval-storage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const data = await readEvalFile('answer-synthesis-raw.json') as {
    test_cases: Array<{ test_case_id: string }>;
  } | null;

  if (!data) {
    return NextResponse.json(
      { error: 'answer-synthesis-raw.json not found. Run stage 1 first.' },
      { status: 404 },
    );
  }

  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    const tc = data.test_cases.find(t => t.test_case_id === id);
    return tc
      ? NextResponse.json(tc)
      : NextResponse.json({ error: 'Test case not found' }, { status: 404 });
  }

  return NextResponse.json(data);
}
```

**Step 4: Create GET /api/eval/review-synthesis (HTML page)**

Create `src/app/api/eval/review-synthesis/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { SYNTHESIS_REVIEW_HTML } from '@/lib/eval-html-templates';

export const dynamic = 'force-dynamic';

export async function GET() {
  return new NextResponse(SYNTHESIS_REVIEW_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
```

**Step 5: Commit**

```bash
git add src/app/api/eval/synthesis-eval/ src/app/api/eval/synthesis-raw/ src/app/api/eval/review-synthesis/
git commit -m "feat(eval): add synthesis review API routes"
```

---

### Task 5: Add cite report API routes

**Files:**
- Create: `src/app/api/eval/cite-report/route.ts`
- Create: `src/app/api/eval/review-cite/route.ts`

**Step 1: Create GET /api/eval/cite-report**

Create `src/app/api/eval/cite-report/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { readEvalFile } from '@/lib/eval-storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const data = await readEvalFile('cite-report-latest.json');
  if (!data) {
    return NextResponse.json(
      { error: 'No cite report found. Run eval:cite then eval:upload.' },
      { status: 404 },
    );
  }
  return NextResponse.json(data);
}
```

**Step 2: Create GET /api/eval/review-cite (HTML page)**

Create `src/app/api/eval/review-cite/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { CITE_REPORT_HTML } from '@/lib/eval-html-templates';

export const dynamic = 'force-dynamic';

export async function GET() {
  return new NextResponse(CITE_REPORT_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
```

**Step 3: Commit**

```bash
git add src/app/api/eval/cite-report/ src/app/api/eval/review-cite/
git commit -m "feat(eval): add cite report viewer API routes"
```

---

### Task 6: Extract and adapt HTML templates

**Files:**
- Create: `src/lib/eval-html-templates.ts`
- Reference: `evaluation/serve-label-review.ts` (lines 29-620 for REVIEW_HTML, lines 625-1125 for SYNTHESIS_REVIEW_HTML)

**Step 1: Create the templates module**

Create `src/lib/eval-html-templates.ts` containing three exported constants: `REVIEW_HTML`, `SYNTHESIS_REVIEW_HTML`, and `CITE_REPORT_HTML`.

**For REVIEW_HTML:** Copy the `REVIEW_HTML` template string from `evaluation/serve-label-review.ts` (lines 29-620). Make these find-and-replace changes:
- `fetch('/api/labels/override'` → `fetch('/api/eval/labels/override'`
- `fetch('/api/labels')` → `fetch('/api/eval/labels')`

**For SYNTHESIS_REVIEW_HTML:** Copy the `SYNTHESIS_REVIEW_HTML` template string from `evaluation/serve-label-review.ts` (lines 625-1125). Make these find-and-replace changes:
- `fetch('/api/synthesis-eval/review'` → `fetch('/api/eval/synthesis-eval/review'`
- `fetch('/api/synthesis-eval')` → `fetch('/api/eval/synthesis-eval')`
- `fetch('/api/synthesis-raw')` → `fetch('/api/eval/synthesis-raw')`

**For CITE_REPORT_HTML:** Create a new self-contained HTML template following the same pattern as the other two. It should:

- Fetch JSON from `/api/eval/cite-report`
- Display a summary bar: overall precision (%), recall (%), F1 (%), pass rate (X/N queries)
- Display a table with columns: Query, Type, Precision, Recall, F1, Expected, Retrieved, Pass/Fail badge
- Pass criteria: recall >= 0.75 AND precision >= 0.15 AND f1 >= 0.25
- Color coding: green for pass, red for fail
- Show timestamp from the report
- Match the visual style of the other two review pages (same CSS variables, font, layout)

The cite report HTML template should be approximately 200-250 lines (it's view-only, much simpler than the review pages).

**Step 2: Verify the module compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`

**Step 3: Commit**

```bash
git add src/lib/eval-html-templates.ts
git commit -m "feat(eval): extract HTML templates with updated API URLs and cite viewer"
```

---

### Task 7: Create upload/download scripts

**Files:**
- Create: `evaluation/upload-eval-to-s3.ts`
- Create: `evaluation/download-eval-from-s3.ts`
- Modify: `package.json`

**Step 1: Create upload script**

Create `evaluation/upload-eval-to-s3.ts`:

```typescript
/**
 * Upload eval data files to S3 for QA reviewer access.
 *
 * Usage:
 *   npm run eval:upload                              # upload all files
 *   npm run eval:upload -- --file answer-labels-review.json  # upload one
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';

const EVAL_DIR = __dirname;
const RESULTS_DIR = path.join(EVAL_DIR, 'results');

const BUCKET = process.env.DOCUMENTS_S3_BUCKET;
const PREFIX = process.env.EVAL_S3_PREFIX || 'eval-data/';

const EVAL_FILES = [
  'answer-labels-review.json',
  'answer-synthesis-eval-final.json',
  'answer-synthesis-raw.json',
];

async function uploadFile(client: S3Client, localPath: string, s3Key: string): Promise<boolean> {
  if (!fs.existsSync(localPath)) {
    console.log(`  SKIP: ${path.basename(localPath)} (not found)`);
    return false;
  }
  const body = fs.readFileSync(localPath, 'utf-8');
  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
    Body: body,
    ContentType: 'application/json',
  }));
  console.log(`  OK: ${path.basename(localPath)} → s3://${BUCKET}/${s3Key}`);
  return true;
}

function findLatestCiteReport(): string | null {
  if (!fs.existsSync(RESULTS_DIR)) return null;
  const files = fs.readdirSync(RESULTS_DIR)
    .filter(f => f.startsWith('eval-report-') && f.endsWith('.json'))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(RESULTS_DIR, files[0]) : null;
}

async function main() {
  if (!BUCKET) {
    console.error('DOCUMENTS_S3_BUCKET not set');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const singleFile = fileIdx >= 0 ? args[fileIdx + 1] : null;

  const client = new S3Client({});
  let uploaded = 0;

  console.log(`Uploading to s3://${BUCKET}/${PREFIX}\n`);

  if (singleFile) {
    const ok = await uploadFile(client, path.join(EVAL_DIR, singleFile), `${PREFIX}${singleFile}`);
    if (ok) uploaded++;
  } else {
    for (const file of EVAL_FILES) {
      const ok = await uploadFile(client, path.join(EVAL_DIR, file), `${PREFIX}${file}`);
      if (ok) uploaded++;
    }

    // Upload latest cite report
    const citeReport = findLatestCiteReport();
    if (citeReport) {
      const ok = await uploadFile(client, citeReport, `${PREFIX}cite-report-latest.json`);
      if (ok) uploaded++;
    }
  }

  console.log(`\nUploaded ${uploaded} file(s)`);
}

main().catch(err => { console.error(err); process.exit(1); });
```

**Step 2: Create download script**

Create `evaluation/download-eval-from-s3.ts`:

```typescript
/**
 * Download eval data files from S3 (after human review on QA).
 *
 * Usage: npm run eval:download
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';

const EVAL_DIR = __dirname;
const BUCKET = process.env.DOCUMENTS_S3_BUCKET;
const PREFIX = process.env.EVAL_S3_PREFIX || 'eval-data/';

const DOWNLOAD_FILES = [
  'answer-labels-review.json',
  'answer-synthesis-eval-final.json',
];

async function downloadFile(client: S3Client, s3Key: string, localPath: string): Promise<boolean> {
  try {
    const resp = await client.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
    }));
    const body = await resp.Body?.transformToString('utf-8');
    if (!body) return false;
    fs.writeFileSync(localPath, body, 'utf-8');
    console.log(`  OK: s3://${BUCKET}/${s3Key} → ${path.basename(localPath)}`);
    return true;
  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      console.log(`  SKIP: ${path.basename(localPath)} (not in S3)`);
      return false;
    }
    throw err;
  }
}

async function main() {
  if (!BUCKET) {
    console.error('DOCUMENTS_S3_BUCKET not set');
    process.exit(1);
  }

  const client = new S3Client({});
  let downloaded = 0;

  console.log(`Downloading from s3://${BUCKET}/${PREFIX}\n`);

  for (const file of DOWNLOAD_FILES) {
    const ok = await downloadFile(client, `${PREFIX}${file}`, path.join(EVAL_DIR, file));
    if (ok) downloaded++;
  }

  console.log(`\nDownloaded ${downloaded} file(s)`);
}

main().catch(err => { console.error(err); process.exit(1); });
```

**Step 3: Add npm scripts to package.json**

Add to `scripts` in `package.json`:

```json
"eval:upload": "npx tsx evaluation/upload-eval-to-s3.ts",
"eval:download": "npx tsx evaluation/download-eval-from-s3.ts"
```

**Step 4: Commit**

```bash
git add evaluation/upload-eval-to-s3.ts evaluation/download-eval-from-s3.ts package.json
git commit -m "feat(eval): add S3 upload/download scripts for eval data"
```

---

### Task 8: Update Terraform IAM policy

**Files:**
- Modify: `terraform/infrastructure/ecs.tf`

**Step 1: Add PutObject permission for eval data**

In `terraform/infrastructure/ecs.tf`, find the `aws_iam_role_policy.ecs_task_s3` resource (around line 121). Add a third Statement to the policy:

```hcl
{
  Sid    = "PutEvalObjects"
  Effect = "Allow"
  Action = [
    "s3:PutObject"
  ]
  Resource = "arn:aws:s3:::${var.documents_s3_bucket}/eval-data/*"
}
```

This goes after the existing `GetObjects` statement (around line 150), inside the `Statement = [...]` array.

**Step 2: Add EVAL_S3_PREFIX env var to Next.js container**

In the same file, find the Next.js container `environment` block (around line 181). Add to the static environment list (after the `SEARCH_SERVICE_URL` entry):

```hcl
{
  name  = "EVAL_S3_PREFIX"
  value = "eval-data/"
}
```

**Step 3: Verify Terraform validates**

Run: `cd terraform/infrastructure && terraform validate`
Expected: `Success! The configuration is valid.`

Note: You may need to run `terraform init` first if you haven't. If terraform is not installed locally, skip this step — CI will validate.

**Step 4: Commit**

```bash
git add terraform/infrastructure/ecs.tf
git commit -m "infra: add S3 PutObject permission for eval data and EVAL_S3_PREFIX env var"
```

---

### Task 9: Update evaluation README

**Files:**
- Modify: `evaluation/README.md`

**Step 1: Add QA Reviewer Access section**

After the "Checking Results" section and before "File Structure", add a new section:

```markdown
---

## QA Reviewer Access

External reviewers access the evaluation UIs via the QA server — no local setup required.

**Review URLs (QA):**
- Label review: `http://<qa-alb>/api/eval/review-labels`
- Synthesis review: `http://<qa-alb>/api/eval/review-synthesis`
- Cite report: `http://<qa-alb>/api/eval/review-cite`

**Developer workflow:**
```bash
# 1. Run evals locally
npm run eval:cite
npm run eval:answer-retrieval
npm run eval:synthesis-capture
npm run eval:synthesis-llm-eval
npm run eval:synthesis-prepare-review

# 2. Upload data to S3 for reviewers
export DOCUMENTS_S3_BUCKET=askwri-data
npm run eval:upload

# 3. After reviewer completes their work, pull data back
npm run eval:download

# 4. Continue with assembly
npm run eval:golden-assemble
npm run eval:synthesis-assemble
```
```

**Step 2: Add upload/download to Quick Reference**

Add to the Quick Reference section:

```markdown
**S3 Sync (QA Reviewer Workflow):**
```bash
npm run eval:upload                # push eval data to S3
npm run eval:download              # pull reviewed data from S3
```
```

**Step 3: Update File Structure**

Add to the file structure tree under the `# Shared infrastructure` section:

```
├── upload-eval-to-s3.ts                   # Push eval data to S3 for QA reviewers
├── download-eval-from-s3.ts               # Pull reviewed data from S3
```

Add a new section for Next.js eval routes:

```
src/
├── lib/
│   ├── eval-storage.ts                    # S3/local eval file storage abstraction
│   └── eval-html-templates.ts             # HTML templates for review UIs
└── app/api/eval/
    ├── labels/route.ts                    # GET labels JSON
    ├── labels/override/route.ts           # POST label override
    ├── review-labels/route.ts             # GET label review HTML page
    ├── synthesis-eval/route.ts            # GET synthesis eval JSON
    ├── synthesis-eval/review/route.ts     # POST human eval update
    ├── synthesis-raw/route.ts             # GET captured passages JSON
    ├── review-synthesis/route.ts          # GET synthesis review HTML page
    ├── cite-report/route.ts              # GET cite report JSON
    └── review-cite/route.ts              # GET cite report HTML page
```

**Step 4: Commit**

```bash
git add evaluation/README.md
git commit -m "docs(eval): add QA reviewer access, upload/download commands, updated file structure"
```

---

### Task 10: Verify build and tests

**Step 1: Run tests**

Run: `npm test`
Expected: All existing tests pass (no new tests needed — the routes are thin wrappers around eval-storage)

**Step 2: Run Next.js build**

Run: `npm run build 2>&1 | tail -30`
Expected: Build succeeds. The new API routes should appear in the build output under `/api/eval/*`.

**Step 3: Spot-check local dev**

Run: `npm run dev &`

Then test:
- `curl -s http://localhost:3000/api/eval/labels | head -1` → should return `{"error":"answer-labels-review.json not found..."}` or the JSON if the file exists locally
- `curl -s http://localhost:3000/api/eval/review-cite | head -5` → should return HTML
- `curl -s http://localhost:3000/api/eval/cite-report | head -1` → should return JSON or 404

Kill the dev server when done.

**Step 4: Commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(eval): build/test fixes for eval review UI migration"
```
