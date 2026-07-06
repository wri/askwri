# Local Dev Environment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One idempotent command brings up a full-fidelity local AskWRI stack (Postgres+pgvector, MinIO as S3, all three services in QA modes) with zero AWS access, fully documented for humans and agents.

**Architecture:** Docker Compose provides Postgres and MinIO; a gitignored `.env.local` convention overrides the deploy-day `.env` without touching it (four small code changes make every entry point honor it); `scripts/local-bootstrap.sh` orchestrates setup end-to-end. See the approved spec: [2026-07-06-local-dev-environment-design.md](2026-07-06-local-dev-environment-design.md).

**Tech Stack:** bash, Docker Compose (pgvector/pgvector:pg16, minio/minio, minio/mc), pydantic-settings, python-dotenv, dotenv (Node), AWS SDK v3, Jest, pytest.

---

## Documentation directive (first-class deliverable — do not skip)

This plan is **not done** until both audiences can operate the local stack without reading this plan:

- **Humans:** `docs/runbooks/local-testing.md` gets a bootstrap-first section and stale-claim corrections (Tasks 11).
- **Agents:** `CLAUDE.md` gets the bootstrap command and the env-file precedence rules (Task 12) — subagents don't inherit conversation context, so anything they need must be in `CLAUDE.md` or the runbook.
- **Self-documenting artifacts:** the bootstrap script's header comment, the compose file's header comment, and every generated `.env.local` template must explain what loads them and in what precedence order. These comments are specified in the tasks below — write them exactly.

Tasks 11–13 are mandatory. A task that changes behavior and skips its docs step is incomplete.

## Context for the implementer (read first)

- **Never touch `.env`, `search-service/.env`, or anything under `terraform/`.** `.env` points at the QA RDS and is the deploy-day reference. All local values go in gitignored `*.local` files.
- **Env precedence, everywhere, always:** real environment variable > `.env.local` > `.env`. Each loader implements this differently (dotenv `override=False` = first-loaded-wins → load `.env.local` FIRST; pydantic `env_file` tuple = later-file-wins → list `.env.local` LAST). Get the order right per mechanism.
- **Jest trap:** `next/jest` runs with `NODE_ENV=test`; Next.js skips `.env.local` in test mode. That's why `.env.test.local` exists (and why it, not `.env.test`, is used — only the former is gitignored).
- **boto3 reads `os.environ`, not pydantic Settings.** That's why Task 1's loader exports to the process env.
- Pre-existing test baselines (must not regress): `npm test` 132 pass · `npm run test:db` 33 pass · `npm run test:python` 98 pass, 0 skips (once DB is up).
- `package-lock.json` has an unrelated pre-existing local modification — never `git add` it (stage files explicitly; no `git commit -am`).
- Commit messages: plain conventional commits, **no Co-Authored-By trailers**.
- Repo conventions in `CLAUDE.md` apply. Prod build locally is `npx next build --webpack` (Turbopack panics on the venv symlink).

### File structure (what gets created/modified)

| File | Role |
|---|---|
| Create `search-service/app/env.py` | shared process-env loader (`.env.local` → `.env`) |
| Create `search-service/tests/test_env_loading.py` | tests for it |
| Modify `search-service/app/main.py:9,14`, `worker/main.py:11,13`, `tests/conftest.py:15-20` | use the shared loader |
| Modify `search-service/app/config.py:8` | pydantic `env_file` tuple |
| Create `search-service/tests/test_config_env_local.py` | tests for it |
| Create `src/lib/s3.ts` + `src/__tests__/s3-client-config.test.ts` | S3 client config helper (MinIO endpoint + path style) |
| Modify `src/app/api/admin/intake/route.ts:65`, `src/app/api/admin/documents/[id]/file/route.ts:29`, `src/lib/eval-storage.ts:14` | use the helper |
| Create `scripts/load-env.js`; modify `package.json` scripts | ts-node CLI preload |
| Create `docker-compose.local.yml` | pg + MinIO |
| Create `scripts/local-bootstrap.sh` | orchestrator |
| Create `search-service/scripts/make_canary_pdf.py` | unique test PDF generator for worker e2e |
| Modify `docs/runbooks/local-testing.md`, `CLAUDE.md`, `.env.example`, `docs/plans/2026-07-02-next-steps-qa-deploy.md` | documentation |

---

### Task 1: Shared process-env loader (`app/env.py`)

**Files:**
- Create: `search-service/app/env.py`
- Create: `search-service/tests/test_env_loading.py`
- Modify: `search-service/app/main.py:9,14`
- Modify: `search-service/worker/main.py:11,13`
- Modify: `search-service/tests/conftest.py:1-20`

- [ ] **Step 1: Write the failing test**

`search-service/tests/test_env_loading.py`:

```python
"""app.env.load_env: .env.local wins over .env; real env wins over both."""
import os

from app.env import load_env


def test_env_local_wins_and_env_still_loads(tmp_path):
    (tmp_path / ".env").write_text("ASKWRI_CANARY_A=from_env\nASKWRI_CANARY_B=base\n")
    (tmp_path / ".env.local").write_text("ASKWRI_CANARY_A=from_env_local\n")
    try:
        load_env(tmp_path)
        assert os.environ["ASKWRI_CANARY_A"] == "from_env_local"
        assert os.environ["ASKWRI_CANARY_B"] == "base"
    finally:
        os.environ.pop("ASKWRI_CANARY_A", None)
        os.environ.pop("ASKWRI_CANARY_B", None)


def test_real_env_beats_both(tmp_path, monkeypatch):
    monkeypatch.setenv("ASKWRI_CANARY_A", "real")
    (tmp_path / ".env").write_text("ASKWRI_CANARY_A=from_env\n")
    (tmp_path / ".env.local").write_text("ASKWRI_CANARY_A=from_env_local\n")
    load_env(tmp_path)
    assert os.environ["ASKWRI_CANARY_A"] == "real"


def test_missing_files_are_fine(tmp_path):
    load_env(tmp_path)  # no .env/.env.local in tmp_path — must not raise
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd search-service && ./venv/bin/python -m pytest tests/test_env_loading.py -v
```
Expected: FAIL/ERROR with `ModuleNotFoundError: No module named 'app.env'`

- [ ] **Step 3: Implement `search-service/app/env.py`**

```python
"""Process-env loader for local dev: .env.local (gitignored overrides), then .env.

override=False means the first value loaded wins, and anything already in the
real environment beats both files — the same precedence pydantic Settings gets
from its env_file tuple in app/config.py. Used by app.main, worker.main, and
tests/conftest so that os.environ consumers (boto3 reads AWS_ENDPOINT_URL and
credentials from the process env, never from pydantic Settings) see the same
values as everything else.
"""
from pathlib import Path

from dotenv import load_dotenv

_BASE = Path(__file__).resolve().parent.parent  # search-service/


def load_env(base: Path | None = None) -> None:
    for name in (".env.local", ".env"):
        path = (base or _BASE) / name
        if path.exists():
            load_dotenv(path, override=False)
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd search-service && ./venv/bin/python -m pytest tests/test_env_loading.py -v
```
Expected: 3 passed

- [ ] **Step 5: Wire the three call sites**

`search-service/app/main.py` — replace line 9 (`from dotenv import load_dotenv`) and line 14 (`load_dotenv()`) with:

```python
from app.env import load_env
```
```python
load_env()  # local dev: .env.local then .env into os.environ (see app/env.py)
```

`search-service/worker/main.py` — replace line 11 (`from dotenv import load_dotenv`) and line 13 (`load_dotenv()  # local dev: export .env ...`) with the same two lines (keep the import above the `app.config` import, as `load_dotenv` was).

`search-service/tests/conftest.py` — replace lines 15–20 (the `_env_path` block) with:

```python
# Load .env.local then .env before any skip markers are evaluated — this file
# is imported by pytest before test modules are collected. See app/env.py for
# the precedence rules.
from app.env import load_env

load_env()
```

Also update the conftest module docstring's first paragraph to say "Loads .env.local then .env from the search-service directory early…".

- [ ] **Step 6: Run the full non-DB python suite to check nothing broke**

```bash
cd search-service && ./venv/bin/python -m pytest tests/ -v
```
Expected: 101 passed (98 + 3 new) OR passes-with-skips for DB-gated suites (DB not up yet — that's fine at this task; zero-skip enforcement comes with `.env.local` in Task 7).

- [ ] **Step 7: Commit**

```bash
git add search-service/app/env.py search-service/tests/test_env_loading.py search-service/app/main.py search-service/worker/main.py search-service/tests/conftest.py
git commit -m "feat(local-dev): shared .env.local-first process-env loader"
```

---

### Task 2: pydantic Settings reads `.env.local`

**Files:**
- Modify: `search-service/app/config.py:8`
- Create: `search-service/tests/test_config_env_local.py`

- [ ] **Step 1: Write the failing test**

`search-service/tests/test_config_env_local.py`:

```python
"""Settings env_file chain: .env.local overrides .env; real env beats files."""
from app.config import Settings


def test_env_local_overrides_env(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("RETRIEVAL_BACKEND=legacy\nPORT=8123\n")
    (tmp_path / ".env.local").write_text("RETRIEVAL_BACKEND=postgres\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("RETRIEVAL_BACKEND", raising=False)
    monkeypatch.delenv("PORT", raising=False)
    s = Settings()
    assert s.retrieval_backend == "postgres"  # .env.local wins
    assert s.port == 8123  # .env still read for keys .env.local lacks


def test_real_env_beats_files(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("RETRIEVAL_BACKEND=legacy\n")
    (tmp_path / ".env.local").write_text("RETRIEVAL_BACKEND=postgres\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("RETRIEVAL_BACKEND", "memory")
    assert Settings().retrieval_backend == "memory"
```

(Note: `Settings.model_config` uses cwd-relative `env_file` paths, hence `monkeypatch.chdir`. The `delenv` calls matter because conftest exports `.env.local` values into `os.environ` once Task 7 creates that file.)

- [ ] **Step 2: Run it to verify it fails**

```bash
cd search-service && ./venv/bin/python -m pytest tests/test_config_env_local.py -v
```
Expected: `test_env_local_overrides_env` FAILS (`retrieval_backend == "legacy"`); `test_real_env_beats_files` may already pass.

- [ ] **Step 3: Implement — one line in `search-service/app/config.py`**

Replace line 8:

```python
    model_config = SettingsConfigDict(env_file=(".env", ".env.local"), env_file_encoding="utf-8", extra="ignore")
```

(pydantic-settings: **later** file in the tuple takes priority — opposite of dotenv's rule. Real env still beats both.)

- [ ] **Step 4: Run the tests**

```bash
cd search-service && ./venv/bin/python -m pytest tests/test_config_env_local.py tests/test_env_loading.py -v
```
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add search-service/app/config.py search-service/tests/test_config_env_local.py
git commit -m "feat(local-dev): Settings reads .env.local overrides after .env"
```

---

### Task 3: Node S3 client config helper (`src/lib/s3.ts`)

**Files:**
- Create: `src/lib/s3.ts`
- Create: `src/__tests__/s3-client-config.test.ts`
- Modify: `src/app/api/admin/intake/route.ts:2,65`
- Modify: `src/app/api/admin/documents/[id]/file/route.ts:2,29`
- Modify: `src/lib/eval-storage.ts:1,14`

Scope note: `evaluation/upload-eval-to-s3.ts:60` and `evaluation/download-eval-from-s3.ts:46` also construct `S3Client` — they are real-AWS sync scripts, deliberately **not** changed (per spec §2 item 3).

- [ ] **Step 1: Write the failing test**

`src/__tests__/s3-client-config.test.ts`:

```typescript
import { s3ClientConfig } from '@/lib/s3'

describe('s3ClientConfig', () => {
  const original = process.env.AWS_ENDPOINT_URL

  afterEach(() => {
    if (original === undefined) delete process.env.AWS_ENDPOINT_URL
    else process.env.AWS_ENDPOINT_URL = original
  })

  it('returns empty config when AWS_ENDPOINT_URL is unset (production)', () => {
    delete process.env.AWS_ENDPOINT_URL
    expect(s3ClientConfig()).toEqual({})
  })

  it('returns endpoint + forcePathStyle when AWS_ENDPOINT_URL is set (MinIO)', () => {
    process.env.AWS_ENDPOINT_URL = 'http://localhost:9000'
    expect(s3ClientConfig()).toEqual({
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx jest src/__tests__/s3-client-config.test.ts
```
Expected: FAIL — cannot find module `@/lib/s3`

- [ ] **Step 3: Implement `src/lib/s3.ts`**

```typescript
import type { S3ClientConfig } from '@aws-sdk/client-s3'

// Local dev (MinIO): AWS_ENDPOINT_URL points every S3 client at the local
// endpoint, and path-style addressing is required there — virtual-host style
// would try to resolve `<bucket>.localhost`. Unset (production ECS): empty
// config, SDK defaults (task-role credentials, real S3). SDK v3 has no env
// var for forcePathStyle, hence this helper instead of plain `new S3Client({})`.
export function s3ClientConfig(): S3ClientConfig {
  const endpoint = process.env.AWS_ENDPOINT_URL
  return endpoint ? { endpoint, forcePathStyle: true } : {}
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx jest src/__tests__/s3-client-config.test.ts
```
Expected: 2 passed

- [ ] **Step 5: Apply to the 3 app-tier call sites**

- `src/app/api/admin/intake/route.ts`: add `import { s3ClientConfig } from '../../../../lib/s3'` after the existing lib imports (line ~6); line 65: `const s3 = new S3Client(s3ClientConfig())`
- `src/app/api/admin/documents/[id]/file/route.ts`: add `import { s3ClientConfig } from '../../../../../../lib/s3'` (match the depth of the existing `lib/auth/identity` import in that file); line 29: `const s3 = new S3Client(s3ClientConfig())`
- `src/lib/eval-storage.ts`: add `import { s3ClientConfig } from './s3';` (line 4); line 14: `s3Client = new S3Client(s3ClientConfig());`

- [ ] **Step 6: Full Jest + lint**

```bash
npm test
npm run lint
```
Expected: 134 passed (132 + 2 new; DB suites may fail/skip until the DB is up — anything else red is a regression); lint clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/s3.ts src/__tests__/s3-client-config.test.ts src/app/api/admin/intake/route.ts "src/app/api/admin/documents/[id]/file/route.ts" src/lib/eval-storage.ts
git commit -m "feat(local-dev): S3 client honors AWS_ENDPOINT_URL with path-style (MinIO)"
```

---

### Task 4: ts-node CLI preload (`scripts/load-env.js`)

**Files:**
- Create: `scripts/load-env.js`
- Modify: `package.json:19-22,40`

- [ ] **Step 1: Create `scripts/load-env.js`**

```javascript
// Preload for ts-node CLI entry points (typeorm CLI, seed-admin): load the
// gitignored .env.local first, then .env. dotenv never overwrites a variable
// that is already set, so .env.local beats .env, and a real environment
// variable (deploy day: `DATABASE_URL=... npm run migration:run`) beats both.
const { config } = require('dotenv')

config({ path: '.env.local' })
config({ path: '.env' })
```

- [ ] **Step 2: Update `package.json` scripts**

```json
    "typeorm": "ts-node --project tsconfig.typeorm.json -r ./scripts/load-env.js ./node_modules/typeorm/cli.js",
    "migration:generate": "npm run typeorm -- migration:generate src/db/migrations/Migration -d src/db/migration-data-source.ts",
    "migration:run": "npm run typeorm -- migration:run -d src/db/migration-data-source.ts",
    "migration:revert": "npm run typeorm -- migration:revert -d src/db/migration-data-source.ts",
```
and
```json
    "seed:admin": "ts-node --project tsconfig.typeorm.json -r ./scripts/load-env.js scripts/seed-admin.ts"
```
(The `DOTENV_CONFIG_PATH=.env` prefixes are removed — they configured the old `dotenv/config` preload and are dead now.)

- [ ] **Step 3: Smoke-verify the preload resolves and loads**

```bash
node -e "require('./scripts/load-env.js'); console.log('DB_HOST=' + process.env.DB_HOST)"
```
Expected: prints the RDS host from `.env` (no `.env.local` exists yet). Real DB verification happens in Task 7 when `migration:run` runs against local Postgres.

- [ ] **Step 4: Commit**

```bash
git add scripts/load-env.js package.json
git commit -m "feat(local-dev): typeorm/seed CLI scripts load .env.local before .env"
```

---

### Task 5: `docker-compose.local.yml`

**Files:**
- Create: `docker-compose.local.yml`

- [ ] **Step 1: Create the file**

```yaml
# Local-only infrastructure: Postgres (pgvector) standing in for RDS, MinIO
# standing in for S3. Never deployed anywhere. Brought up + seeded by
# scripts/local-bootstrap.sh; documented in docs/runbooks/local-testing.md.
services:
  askwri-pg:
    image: pgvector/pgvector:pg16
    container_name: askwri-pg
    environment:
      POSTGRES_USER: askwri
      POSTGRES_PASSWORD: password
      POSTGRES_DB: qa
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - askwri-pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U askwri -d qa"]
      interval: 2s
      timeout: 3s
      retries: 30

  askwri-minio:
    image: minio/minio
    container_name: askwri-minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: local-askwri
      MINIO_ROOT_PASSWORD: local-askwri-secret
    ports:
      - "127.0.0.1:9000:9000" # S3 API
      - "127.0.0.1:9001:9001" # web console
    volumes:
      - askwri-minio-data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 2s
      timeout: 3s
      retries: 30

networks:
  default:
    name: askwri-local # fixed name so the bootstrap's one-shot mc container can join

volumes:
  askwri-pg-data:
  askwri-minio-data:
```

- [ ] **Step 2: Bring it up and verify health**

```bash
docker compose -f docker-compose.local.yml up -d --wait
```
Expected: exits 0 with both services healthy. If the MinIO healthcheck fails because the image lacks `curl`, replace the test with `["CMD", "mc", "ready", "local"]`; if that also fails, use `test: ["CMD-SHELL", "curl -f http://localhost:9000/minio/health/live || wget -qO- http://localhost:9000/minio/health/live"]` — verify with `docker compose -f docker-compose.local.yml ps`.

```bash
docker exec askwri-pg psql -U askwri -d qa -c "SELECT name, default_version FROM pg_available_extensions WHERE name IN ('vector','uuid-ossp')"
```
Expected: two rows, `vector` at `0.8.x`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.local.yml
git commit -m "feat(local-dev): compose file for local pgvector Postgres + MinIO"
```

---

### Task 6: Canary PDF generator (worker e2e needs unique content)

**Files:**
- Create: `search-service/scripts/make_canary_pdf.py`

Intake dedupes by `content_hash`, so re-dropping any existing corpus PDF is skipped as a duplicate — each e2e run needs a byte-unique PDF. The generator embeds a timestamp. It also emits >200 chars/page of text so the extraction-confidence gate (`quality_min_chars_per_page: 200`) publishes it as `searchable` rather than routing to `needs_review`.

- [ ] **Step 1: Create the generator**

```python
"""Generate a tiny unique PDF for local worker e2e testing.

Each run embeds a timestamp so the content hash is unique (intake dedupes on
content_hash — re-dropping identical bytes is skipped as a duplicate). Emits
~15 lines of text so extraction confidence clears the searchable gate
(quality_min_chars_per_page=200).

Usage: ./venv/bin/python -m scripts.make_canary_pdf [outdir]
Prints the file path and the canary phrase to query for.
"""
import sys
import time
from pathlib import Path


def make_pdf(lines: list[str]) -> bytes:
    parts = ["BT /F1 12 Tf 72 740 Td 16 TL"]
    for line in lines:
        safe = line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        parts.append(f"({safe}) Tj T*")
    parts.append("ET")
    stream = " ".join(parts).encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_at = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_at}\n%%EOF\n"
    ).encode()
    return bytes(out)


def main() -> None:
    outdir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp")
    stamp = int(time.time())
    phrase = f"askwri local e2e canary {stamp}"
    lines = [f"{phrase} — line {i}: sustainable urban mobility test corpus filler text." for i in range(15)]
    path = outdir / f"askwri-canary-{stamp}.pdf"
    path.write_bytes(make_pdf(lines))
    print(f"wrote {path}")
    print(f"canary phrase: {phrase}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify the worker's parser can extract its text**

```bash
cd search-service && ./venv/bin/python -m scripts.make_canary_pdf /tmp
./venv/bin/python -c "
from llama_index.readers.file import PDFReader
import glob
p = sorted(glob.glob('/tmp/askwri-canary-*.pdf'))[-1]
pages = PDFReader().load_data(p)
text = pages[0].text
assert 'askwri local e2e canary' in text, text[:200]
print('extracted OK,', len(text), 'chars')
"
```
Expected: `extracted OK, <n> chars` with n > 500. If extraction fails, fix the generator (not the parser).

- [ ] **Step 3: Commit**

```bash
git add search-service/scripts/make_canary_pdf.py
git commit -m "feat(local-dev): canary PDF generator for worker e2e runs"
```

---

### Task 7: The bootstrap script

**Files:**
- Create: `scripts/local-bootstrap.sh` (mode 755)

- [ ] **Step 1: Create the script**

```bash
#!/bin/bash
# Bootstrap the full local AskWRI stack: docker Postgres (pgvector) + MinIO,
# schema migrations, 169-doc corpus (from the warm cache — no OpenAI cost),
# sparse keyword backfill, MinIO bucket seed, admin user.
#
# Idempotent: every step checks state first. Safe to re-run after a reboot,
# docker wipe, or in a fresh worktree. Never touches .env / search-service/.env
# (deploy-day files); writes the gitignored .env.local, .env.test.local, and
# search-service/.env.local ONLY if they don't already exist.
#
# Usage:  ./scripts/local-bootstrap.sh
# Docs:   docs/runbooks/local-testing.md   (humans)
#         CLAUDE.md "Local development"    (agents)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SS="$REPO_ROOT/search-service"
DATA="$SS/data"
COMPOSE="docker compose -f $REPO_ROOT/docker-compose.local.yml"
psql_local() { docker exec askwri-pg psql -U askwri -d qa -tAc "$1"; }

step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

step "Preflight"
command -v docker >/dev/null || fail "docker not installed / not on PATH"
[ -x "$SS/venv/bin/python" ] || fail "search-service/venv missing — see docs/runbooks/phase0-cutover.md"
pdf_count=$(find "$DATA" -maxdepth 1 -name '*.pdf' 2>/dev/null | wc -l | tr -d ' ')
[ "$pdf_count" -eq 169 ] || fail "corpus incomplete: $pdf_count/169 PDFs in search-service/data — restore before bootstrapping"
[ -f "$DATA/documents.csv" ] || fail "search-service/data/documents.csv missing"
[ -d "$DATA/cache" ] || fail "warm cache missing (search-service/data/cache) — migration would re-embed ~30k chunks (~\$1); restore the cache or delete this check deliberately"
echo "corpus OK: 169 PDFs + documents.csv + warm cache"

step "Symlink /tmp/askWRI_docs -> search-service/data"
if [ ! -e /tmp/askWRI_docs ] && [ ! -L /tmp/askWRI_docs ]; then
  ln -s "$DATA" /tmp/askWRI_docs && echo "created"
elif [ "$(readlink /tmp/askWRI_docs 2>/dev/null)" = "$DATA" ]; then
  echo "already correct"
else
  fail "/tmp/askWRI_docs exists but is not a symlink to $DATA — inspect and remove it manually, then re-run"
fi

step "Containers (postgres :5432, minio :9000/:9001)"
$COMPOSE up -d --wait || fail "containers unhealthy — run '$COMPOSE ps'; check for port conflicts on 5432/9000/9001"
psql_local "SELECT 1" >/dev/null || fail "postgres container not answering"

step "Env files (created only if absent — your edits are never overwritten)"
if [ -f "$REPO_ROOT/.env.local" ]; then echo ".env.local exists — keeping"; else
cat > "$REPO_ROOT/.env.local" <<'EOF'
# Local-dev overrides (gitignored; generated by scripts/local-bootstrap.sh).
# Loaded by: Next.js dev/prod (NOT test — see .env.test.local) and
# scripts/load-env.js (typeorm/seed CLIs). Precedence: real env > .env.local > .env
DB_HOST=localhost
DB_PORT=5432
DB_USER=askwri
DB_PASSWORD=password
DB_NAME=qa
DATABASE_SSL=false
SESSION_SECRET=local-dev-session-secret-0123456789abcdef
CATALOG_SOURCE=postgres
SEARCH_SERVICE_URL=http://127.0.0.1:8000
# S3 -> local MinIO (docker-compose.local.yml). Console: http://localhost:9001
AWS_ENDPOINT_URL=http://localhost:9000
AWS_ACCESS_KEY_ID=local-askwri
AWS_SECRET_ACCESS_KEY=local-askwri-secret
AWS_REGION=us-east-2
DOCUMENTS_S3_BUCKET=askwri-data
DOCUMENTS_S3_PREFIX=
EOF
echo ".env.local written"; fi

if [ -f "$REPO_ROOT/.env.test.local" ]; then echo ".env.test.local exists — keeping"; else
cat > "$REPO_ROOT/.env.test.local" <<'EOF'
# Jest env (gitignored; generated by scripts/local-bootstrap.sh).
# next/jest runs with NODE_ENV=test and Next.js SKIPS .env.local in test mode,
# so the DB-backed *.db.test suites read this file instead.
DATABASE_URL=postgresql://askwri:password@localhost:5432/qa
DB_HOST=localhost
DB_PORT=5432
DB_USER=askwri
DB_PASSWORD=password
DB_NAME=qa
DATABASE_SSL=false
SESSION_SECRET=local-dev-session-secret-0123456789abcdef
EOF
echo ".env.test.local written"; fi

if [ -f "$SS/.env.local" ]; then echo "search-service/.env.local exists — keeping"; else
cat > "$SS/.env.local" <<'EOF'
# Local-dev overrides (gitignored; generated by scripts/local-bootstrap.sh).
# Loaded by: pydantic Settings (app/config.py env_file tuple) AND app/env.py
# into os.environ (app.main, worker.main, tests/conftest — boto3 reads the
# process env, never Settings). Precedence: real env > .env.local > .env
DATABASE_URL=postgresql://askwri:password@localhost:5432/qa
RETRIEVAL_BACKEND=postgres
KEYWORD_BACKEND=sparse
REQUIRE_DB_TESTS=1
# S3 -> local MinIO (docker-compose.local.yml)
AWS_ENDPOINT_URL=http://localhost:9000
AWS_ACCESS_KEY_ID=local-askwri
AWS_SECRET_ACCESS_KEY=local-askwri-secret
AWS_REGION=us-east-2
DOCUMENTS_S3_BUCKET=askwri-data
# DOCUMENTS_S3_PREFIX stays at its 'documents/' default: the worker records the
# same prefix it copies published PDFs to as s3_key, so any value is
# self-consistent. Migrated docs have bare-filename s3_keys seeded by bootstrap.
# INTAKE_LOCAL_DIR intentionally NOT set: the worker must exercise the S3
# (MinIO) intake path — setting it silently switches to the local-dir path.
EOF
echo "search-service/.env.local written"; fi

step "Schema migrations"
(cd "$REPO_ROOT" && npm run migration:run)

step "Corpus -> Postgres (warm cache; skipped when already loaded)"
docs=$(psql_local "SELECT count(*) FROM documents" || echo 0)
if [ "${docs:-0}" -ge 169 ]; then
  echo "skip: $docs documents already present"
else
  (cd "$SS" && ./venv/bin/python -m scripts.migrate_csv_to_postgres)
fi

step "Sparse keyword backfill (skipped when stats exist)"
stats=$(psql_local "SELECT count(*) FROM keyword_corpus_stats" || echo 0)
if [ "${stats:-0}" -ge 1 ]; then
  echo "skip: keyword_corpus_stats populated (refresh manually after bulk changes: scripts.build_sparse_keyword)"
else
  (cd "$SS" && ./venv/bin/python -m scripts.build_sparse_keyword)
fi

step "MinIO seed (bucket askwri-data; bare-filename keys matching migrated s3_key)"
docker run --rm --network askwri-local -v "$DATA:/corpus:ro" --entrypoint /bin/sh minio/mc -c "\
  mc alias set local http://askwri-minio:9000 local-askwri local-askwri-secret >/dev/null && \
  mc mb --ignore-existing local/askwri-data && \
  mc mirror --exclude 'cache/*' --exclude 'feedback/*' --exclude 'documents.csv' /corpus local/askwri-data"

step "Admin user (admin / admin-local-password)"
(cd "$REPO_ROOT" && npm run seed:admin -- admin admin-local-password)

step "Verify"
counts=$(psql_local "SELECT (SELECT count(*) FROM documents) || '/' ||
  (SELECT count(*) FROM documents WHERE status='searchable') || '/' ||
  (SELECT count(*) FROM document_texts) || '/' ||
  (SELECT count(*) FROM document_chunks WHERE embedding IS NULL)")
echo "docs/searchable/texts/missing_embeddings = $counts"
case "$counts" in 169/169/169/0) echo "corpus verified";; *) fail "unexpected counts (want 169/169/169/0)";; esac
vocab=$(psql_local "SELECT count(*) FROM keyword_vocab" || echo "n/a")
echo "sparse vocab terms: $vocab (expect ~184395)"

cat <<'EOF'

Bootstrap complete. Start the stack (three terminals):

  1. search service :8000   cd search-service && ./venv/bin/python -m app.main
  2. web app        :3000   npm run dev
  3. worker (when needed)   cd search-service && ./venv/bin/python -m worker.main

Health check:  curl -s localhost:8000/health
  expect "status":"healthy", "retrieval_backend":"postgres", "keyword_backend":"sparse"
Admin UI:      http://localhost:3000/admin  (admin / admin-local-password)
MinIO console: http://localhost:9001       (local-askwri / local-askwri-secret)
Full guide:    docs/runbooks/local-testing.md
EOF
```

Implementation notes:
- `keyword_vocab` is the assumed sparse-vocab table name — verify against the actual schema in `src/db/migrations/1781310000000-Migration.ts` (or `\dt keyword_*` after migrating) and adjust the verify query to whatever table holds vocabulary terms.
- `chmod +x scripts/local-bootstrap.sh`.

- [ ] **Step 2: Syntax check**

```bash
bash -n scripts/local-bootstrap.sh
```
Expected: silence (exit 0).

- [ ] **Step 3: Commit (before first run, so a failed run can't lose the work)**

```bash
git add scripts/local-bootstrap.sh
git commit -m "feat(local-dev): idempotent local-bootstrap script"
```

---

### Task 8: First bootstrap run + idempotency check

- [ ] **Step 1: Run it**

```bash
./scripts/local-bootstrap.sh
```
Expected, in order: corpus OK → symlink → containers healthy → 3 env files written → 4 migrations run (`178128…178131`) → `Done: 169 documents, <N> chunks.` (several minutes; watch for `Loaded <n> cached embeddings from default__vector_store.json` — if it starts calling OpenAI instead, that's the known ~$1 hash-mismatch case, let it finish) → backfill `vocab 184395; avgdl ~192` → MinIO mirror ~169 objects / ~2.2 GiB → admin seeded → `docs/searchable/texts/missing_embeddings = 169/169/169/0` → next-steps banner.

If any step fails: fix the script (or environment), re-run — every completed step must report `skip`/`already` on the retry. Commit any script fixes individually.

- [ ] **Step 2: Idempotency — run it again**

```bash
./scripts/local-bootstrap.sh
```
Expected: completes in well under a minute; every heavy step reports skip (`documents already present`, `keyword_corpus_stats populated`, env files "exists — keeping", mc mirror copies nothing).

- [ ] **Step 3: Commit any fixes made during the runs**

---

### Task 9: Validation gate — automated suites + Docker builds

No code changes expected in this task; it proves Tasks 1–8. Any failure → fix, commit the fix, re-run the failed command.

- [ ] **Step 1: Jest — DB suites must actually run**

```bash
npm test
```
Expected: 134 passed (132 baseline + 2 from Task 3), including every `*.db.test.ts` suite (they now reach local Postgres via `.env.test.local`). A hang or connection error here means the Jest env files are wrong.

- [ ] **Step 2: `npm run test:db`** — expected: 33 passed.

- [ ] **Step 3: Python — zero skips is the whole point**

```bash
npm run test:python
```
Expected: 103 passed (98 baseline + 5 from Tasks 1–2), **0 skipped**. `REQUIRE_DB_TESTS=1` (from `search-service/.env.local`) turns any silent skip into a loud failure.

- [ ] **Step 4: Lint + prod build**

```bash
npm run lint
npx next build --webpack
```
Expected: both clean.

- [ ] **Step 5: Docker image builds (catches B1-class Dockerfile bugs; no run, no push)**

```bash
docker build -t askwri-app:local-gate .
docker build -t askwri-search:local-gate search-service/
```
Expected: both succeed. (~5–10 min first time.)

---

### Task 10: Validation gate — live stack, retrieval, worker e2e, admin

- [ ] **Step 1: Boot the search service and app**

```bash
cd search-service && ./venv/bin/python -m app.main   # terminal 1 (or background)
npm run dev                                          # terminal 2
curl -s localhost:8000/health
```
Expected: `"status":"healthy"`, `"retrieval_backend":"postgres"`, `"keyword_backend":"sparse"` (~15s after boot).

- [ ] **Step 2: Retrieval checks**

```bash
cd search-service && ./venv/bin/python -m scripts.sparse_parity_check --db
```
Expected: `26/26 queries score-identical`, 26 DB-OK lines.

```bash
npx tsx evaluation/run-non-english-smoke.ts --label local-bootstrap
```
Expected: dense 16/16; BM25 lane 9–11/16 (zh 0–2 is known); es/pt 9/9 at rank 1.

- [ ] **Step 3: Lifecycle (withdraw/restore, immediate, both surfaces)**

Run the §4 lifecycle check from `docs/runbooks/local-testing.md` (withdraw `2022_guia-de-entornos-caminables-seguros_2940` via SQL, `/query` must drop it from all lanes immediately, restore, it returns). Additionally verify the public route: `curl -sI localhost:3000/api/pdf/2022_guia-de-entornos-caminables-seguros_2940.pdf` → 200 normally, 404 while withdrawn.

- [ ] **Step 4: Worker e2e through MinIO intake (S3 branch end-to-end)**

```bash
cd search-service && ./venv/bin/python -m scripts.make_canary_pdf /tmp
# note the printed path + canary phrase
curl -s -c /tmp/askwri-cookies -X POST localhost:3000/api/admin/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin-local-password"}'
curl -s -b /tmp/askwri-cookies -X POST localhost:3000/api/admin/intake -F "files=@/tmp/askwri-canary-<stamp>.pdf"
```
Expected: `{"ok":true,"uploaded":[...]}` — this is the app-tier S3 branch writing to MinIO `intake/`. (If the login payload shape 401s, check `src/app/api/admin/auth/login/route.ts` for the exact field names; UI login at `localhost:3000/admin` + browser upload is the fallback.)

```bash
cd search-service && ./venv/bin/python -m worker.main   # terminal 3; watch it sweep
docker exec askwri-pg psql -U askwri -d qa -c "SELECT stage, status, attempts, last_error FROM ingestion_jobs ORDER BY created_at DESC LIMIT 5"
```
Expected: job advances through parse→…→publish (a few minutes; costs cents of OpenAI). Then verify:
- document `searchable` (if `needs_review`: promote it via `/admin/review` — that exercises the review queue; then continue),
- `s3_key = documents/askwri-canary-<stamp>.pdf` and the object exists in MinIO (console :9001),
- chunks have BOTH vectors: `SELECT count(*) FILTER (WHERE sparse IS NOT NULL), count(*) FROM document_chunks dc JOIN documents d ON d.id=dc.document_id WHERE d.external_id LIKE 'askwri-canary-%'` → equal, nonzero,
- `/query` for the canary phrase (with `"rerank": false, "return_intermediate_results": true`) finds it in `bm25_results` and `vector_results`,
- admin "Open PDF" on the canary document works — **that download comes from MinIO via the S3 branch**,
- public `/api/pdf/askwri-canary-<stamp>.pdf` → **404, and that is the expected result** (boot-only sync gap, documented in the spec; the file was never synced into `/tmp/askWRI_docs`),
- a fresh `audit_log` row exists for the intake and (if used) the review promotion.

Cleanup: withdraw the canary via the admin UI (leaves it in the DB as lifecycle evidence, out of search results).

- [ ] **Step 5: Admin + public UI smoke**

In a browser: public search at `localhost:3000` returns results with working PDF links; `/admin` login works; `/admin/documents` and `/admin/review` render; one admin edit produces an `audit_log` row.

- [ ] **Step 6: Record results**

Append a dated "validated" note (suite counts, parity result, canary external_id) to the PR/commit message of the final docs commit in Task 13 — not a separate file.

---

### Task 11: Human documentation — `docs/runbooks/local-testing.md`

**Files:**
- Modify: `docs/runbooks/local-testing.md`

- [ ] **Step 1: Add a bootstrap-first section at the top** (right after the intro paragraph):

```markdown
## 0. Bootstrap (one command)

./scripts/local-bootstrap.sh

Idempotent; safe after a reboot, docker wipe, or fresh worktree. Stands up
docker Postgres (pgvector) + MinIO (docker-compose.local.yml), writes the
gitignored env files (.env.local, .env.test.local, search-service/.env.local
— only if absent), runs migrations, loads the 169-doc corpus from the warm
cache (no OpenAI cost), backfills the sparse keyword lane, seeds the MinIO
bucket, and creates the admin user (admin / admin-local-password).

Prereqs it checks for you: docker, search-service/venv, and a complete
search-service/data (169 PDFs + documents.csv + cache). It refuses to run
with a partial corpus.

Env-file precedence (all loaders): real env > .env.local > .env. Jest is the
exception to *which file*: NODE_ENV=test skips .env.local, so Jest reads
.env.test.local. Deploy-day commands (`DATABASE_URL=... npm run migration:run`)
are unaffected — explicit env always wins. The deploy-day `.env` is never touched.
```

- [ ] **Step 2: Update the §1 substitutes table** — change the S3 rows to MinIO:

| AWS service | Local substitute | How |
|---|---|---|
| S3 documents bucket | MinIO container `askwri-minio` (bucket `askwri-data`, seeded by bootstrap) | `AWS_ENDPOINT_URL=http://localhost:9000` in the `.env.local` files; local-dir fallback still available via `DOCUMENTS_LOCAL_DIR` |
| S3 intake drop | MinIO `intake/` prefix (the real S3 code path) | leave `INTAKE_LOCAL_DIR` unset; the worker sweeps MinIO. Legacy local-dir mode: set `INTAKE_LOCAL_DIR` |

- [ ] **Step 3: Correct the stale claims** in the "Cannot be tested locally" list: remove "S3-backed Open PDF" (it works two ways now — MinIO S3 branch, or the `ADMIN_PDF_LOCAL_DIR`→`/tmp/askWRI_docs` fallback); the remaining deploy-only surface is IAM/task roles, Secrets-Manager JSON plumbing, ECS wiring, RDS SSL/extension state, and the deploy pipeline.

- [ ] **Step 4: Add to §7 known gotchas:**
  - Node is pinned `>=24` in `package.json` engines but v23.10 works; unenforced — upgrade at leisure.
  - If the corpus migration logs OpenAI embedding calls instead of `Loaded ... cached embeddings`, the cache content-hash missed — one-time ~$1 re-embed, let it run.
  - A doc ingested by the worker gets a working admin Open PDF but a 404 public PDF link until the app container re-syncs at boot (deploy-side gap, tracked in the deploy plan follow-ups) — locally this shows up on canary docs and is expected.
  - Worker e2e: use `scripts.make_canary_pdf` — re-dropping identical bytes is deduped by content_hash and will be skipped.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/local-testing.md
git commit -m "docs: bootstrap-first local testing guide (MinIO, env precedence, gotchas)"
```

---

### Task 12: Agent documentation — `CLAUDE.md` + `.env.example`

**Files:**
- Modify: `CLAUDE.md` (Commands section + new short section)
- Modify: `.env.example` (pointer comment)

- [ ] **Step 1: Add to the `## Commands` list in `CLAUDE.md`:**

```markdown
- `./scripts/local-bootstrap.sh` — one-command local stack (docker pgvector Postgres
  + MinIO via `docker-compose.local.yml`, migrations, corpus, sparse backfill, bucket
  seed, admin user `admin`/`admin-local-password`). Idempotent. Details:
  `docs/runbooks/local-testing.md`.
```

- [ ] **Step 2: Add a new section after `## Env vars` in `CLAUDE.md`:**

```markdown
## Local dev env files (no AWS)

Gitignored overrides; precedence everywhere: real env > `.env.local` > `.env`.
Never edit `.env` / `search-service/.env` for local values — they are the
deploy-day reference.

| File | Loaded by |
|---|---|
| `.env.local` | Next.js dev/prod; `scripts/load-env.js` (typeorm/seed CLIs) |
| `.env.test.local` | Jest only — `NODE_ENV=test` makes Next.js skip `.env.local` |
| `search-service/.env.local` | pydantic Settings (`app/config.py`) AND `app/env.py` → `os.environ` (boto3 reads the process env, not Settings) |

S3 locally = MinIO (`AWS_ENDPOINT_URL=http://localhost:9000`, console :9001).
Testing the worker's S3 intake lane requires `INTAKE_LOCAL_DIR` to be UNSET.
Worker e2e PDFs: generate with `scripts.make_canary_pdf` (content-hash dedup
rejects re-dropped identical files).
```

- [ ] **Step 3: Append to `.env.example`:**

```
# Local development without AWS: run ./scripts/local-bootstrap.sh, which writes
# gitignored .env.local / .env.test.local / search-service/.env.local overrides.
# Precedence: real env > .env.local > .env. See docs/runbooks/local-testing.md.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .env.example
git commit -m "docs: agent-facing local-dev commands and env-file rules (CLAUDE.md)"
```

---

### Task 13: Cross-doc consistency + follow-up finding

**Files:**
- Modify: `docs/plans/2026-07-02-next-steps-qa-deploy.md` (Part 2 follow-ups)
- Verify: format/lint pass over everything changed

- [ ] **Step 1: Record the boot-only sync gap as a deploy follow-up** — add under the 🟡 "Verify / harden" list in `docs/plans/2026-07-02-next-steps-qa-deploy.md`:

```markdown
- [ ] **R5 — Public PDF links 404 for worker-ingested docs until app restart.** `start-app.sh`
  syncs S3→`/tmp/askWRI_docs` once at boot; a doc published later gets working search and
  admin Open PDF but a 404 public link. Confirm on QA after the first worker ingest; fix
  candidates: periodic re-sync, or serve `/api/pdf/` from S3 with local-dir fallback.
  (Found while building the local dev environment, 2026-07-06.)
```

- [ ] **Step 2: Consistency sweep** — confirm: runbook §0 matches the actual bootstrap output; CLAUDE.md table matches the loaders implemented in Tasks 1–4; the spec's §2/§3 match what shipped (if implementation deviated, update the spec — it is the record).

- [ ] **Step 3: Format + final full check**

```bash
npm run format:check
npm test
npm run lint
```
Expected: all clean (run `npm run format` first if format:check flags the edited files, then re-stage).

- [ ] **Step 4: Final commit**

```bash
git add docs/plans/2026-07-02-next-steps-qa-deploy.md docs/plans/2026-07-06-local-dev-environment-design.md
git commit -m "docs: record R5 boot-sync follow-up; align spec with as-built local env"
```

Include in this commit message body the Task 10 Step 6 validation record (suite counts, parity result, canary id).

---

## Definition of done

1. `./scripts/local-bootstrap.sh` twice in a row: first run builds everything, second run all-skips in <1 min.
2. All suites green with **zero DB skips**: Jest 134 (incl. `*.db.test`), test:db 33, pytest 103.
3. `/health` shows `postgres` + `sparse`; parity 26/26; non-English smoke at baseline.
4. Canary PDF: MinIO intake → worker publish → both vector lanes → `/query` hit → admin Open PDF from MinIO. Public 404 on the canary understood and documented (R5).
5. Docs shipped for both audiences (runbook §0 + CLAUDE.md) and consistent with as-built behavior.
6. `.env`, `search-service/.env`, `terraform/` untouched; `package-lock.json` not committed.
