# Experts Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An unlisted `/experts` page that ranks WRI people by published-work evidence for a query and shows them in a topic-space graph.

**Architecture:** A Next.js route (`/api/experts`) calls the search service `/query` (cite preset, 200 results) and a new additive `/tags/nearby` endpoint sequentially, loads every searchable *work* (original + confirmed translations) in one SQL query, and ranks people in a pure TypeScript module. The page renders a ranked list, a `d3-force` topic graph (static synchronous layout), and an evidence panel; peers and the graph are derived client-side from the response.

**Tech Stack:** Next.js 16 App Router, TypeORM 0.3 raw SQL, Chakra 3 + `@worldresources/wri-design-systems`, `d3-force`, Jest (jsdom + node), FastAPI + pytest.

**Spec:** `docs/superpowers/specs/2026-09-09-experts-mode-design.md` (mockup: `docs/superpowers/specs/2026-09-09-experts-mode-mockup.html`). Read both before starting.

## Global Constraints

- `/query` request/response contract (`QueryRequest`/`QueryResponse` in `search-service/app/main.py`) is untouched.
- All counts are over **works**: an original searchable doc plus its confirmed `translation_of` rows.
- Authors always come from `documents.authors`, never from `/query` chunk metadata.
- Office normalized on read: `WRI México` → `WRI Mexico`.
- Every numeric weight and threshold is a prototype default; code comments must say so and name the cost of changing it.
- Only new dependency: `d3-force` (+ `@types/d3-force`).
- Base branch `qa`. Never push to `main` or `production`.
- One command per Bash call; no `&&`, pipes, or env prefixes (global rules).
- Search-service tests: `cd search-service && ./venv/bin/python -m pytest tests/<file> -v` (the `cd` is the documented exception in CLAUDE.md commands). Jest: `npx jest <path>`.
- Commit after each task. No `Co-Authored-By` trailers.

## File structure

| File | Responsibility |
|---|---|
| `search-service/app/topic_sense.py` (modify) | `nearby_tags` gains optional `top_k` |
| `search-service/app/main.py` (modify) | `POST /tags/nearby` |
| `search-service/tests/test_tags_nearby.py` (new) | endpoint tests |
| `src/db/migrations/1788000000000-ExpertsQueryLogs.ts` (new) | table DDL |
| `src/db/entities/ExpertsModeQueryLogs.entity.ts` (new) | entity |
| `src/db/queries/insertExpertsModeQueryLog.ts` (new) | insert |
| `src/app/api/experts-mode-query-logs/route.ts` (new) | log POST |
| `src/lib/experts/types.ts` (new) | shared types for evidence, ranking, API |
| `src/db/queries/expertsEvidence.ts` (new) | `loadSearchableWorks()` |
| `src/lib/experts/authorKey.ts` (new) | author keying + organization detection |
| `src/lib/experts/rank.ts` (new) | scoring, candidates, silent corpus, output shaping |
| `src/lib/experts/peers.ts` (new) | specificity-weighted peers (shared client/server) |
| `src/lib/experts/layout.ts` (new) | seeded `d3-force` layout |
| `src/app/api/experts/route.ts` (new) | orchestration |
| `src/lib/experts-client.ts` (new) | browser fetch helper |
| `src/app/components/QuerySuggestions/*` (modify) | `'experts'` mode + pool |
| `src/app/components/Experts/TopicChips.tsx` (new) | matched-topic chips with strength |
| `src/app/components/Experts/ExpertsList.tsx` (new) | ranked rows |
| `src/app/components/Experts/ExpertEvidence.tsx` (new) | evidence panel |
| `src/app/components/Experts/OrganizationsStrip.tsx` (new) | organizations line |
| `src/app/components/Experts/TopicGraph.tsx` (new) | SVG graph |
| `src/app/components/Experts/Experts.css` (new) | hover/focus states |
| `src/app/experts/page.tsx` (new) | page, states, URL state, logging |
| `evaluation/experts/README.md`, `queries.json`, `validate.ts` (new) | labeled-set skeleton |

---

### Task 1: `/tags/nearby` endpoint

**Files:**
- Modify: `search-service/app/topic_sense.py:59-75`
- Modify: `search-service/app/main.py` (after the `/health` handler, ~line 950)
- Test: `search-service/tests/test_tags_nearby.py`

**Interfaces:**
- Produces: `POST /tags/nearby` body `{query: str, facets: list[str] = ["topic"], top_k: int = 10}` → `{facets: {facet: [[label, cosine], ...]}, model: str, degraded: list[str]}`.
- Produces: `nearby_tags(query_embedding, facet, top_k: int | None = None)`; `None` keeps `settings.topic_sense_top_k`.

- [ ] **Step 1: Write the failing tests**

```python
# search-service/tests/test_tags_nearby.py
"""POST /tags/nearby — additive query→tag lookup for the experts mode.

Wraps topic_sense.nearby_tags per facet. Never raises for a facet failure;
the facet is named in `degraded` instead. /query is untouched."""
import httpx
import pytest

import app.main as _main
import app.topic_sense as ts


class _Embed:
    def __init__(self):
        self.calls = []

    def get_query_embedding(self, q):
        self.calls.append(q)
        return [0.0] * 1536


@pytest.fixture
def client(monkeypatch):
    embed = _Embed()
    monkeypatch.setitem(_main.service_state, "embed_model", embed)
    monkeypatch.setattr(ts, "model_has_tag_embeddings", lambda m: True)
    transport = httpx.ASGITransport(app=_main.app)
    return httpx.AsyncClient(transport=transport, base_url="http://test"), embed


@pytest.mark.asyncio
async def test_returns_per_facet_matches_and_passes_top_k(client, monkeypatch):
    c, embed = client
    seen = {}

    def fake_nearby(emb, facet, top_k=None):
        seen[facet] = top_k
        return [("Electric Mobility", 0.66)] if facet == "topic" else [("China", 0.41)]

    monkeypatch.setattr(ts, "nearby_tags", fake_nearby)
    async with c:
        r = await c.post("/tags/nearby", json={"query": "electric buses",
                                               "facets": ["topic", "geography"], "top_k": 10})
    assert r.status_code == 200
    body = r.json()
    assert body["facets"] == {"topic": [["Electric Mobility", 0.66]], "geography": [["China", 0.41]]}
    assert body["degraded"] == []
    assert seen == {"topic": 10, "geography": 10}
    assert embed.calls == ["electric buses"]


@pytest.mark.asyncio
async def test_failing_facet_is_degraded_not_500(client, monkeypatch):
    c, _ = client

    def fake_nearby(emb, facet, top_k=None):
        if facet == "geography":
            raise RuntimeError("no table")
        return [("Buses", 0.5)]

    monkeypatch.setattr(ts, "nearby_tags", fake_nearby)
    async with c:
        r = await c.post("/tags/nearby", json={"query": "buses", "facets": ["topic", "geography"]})
    assert r.status_code == 200
    assert r.json()["facets"] == {"topic": [["Buses", 0.5]], "geography": []}
    assert r.json()["degraded"] == ["geography"]


@pytest.mark.asyncio
async def test_no_embed_model_degrades_every_facet(client, monkeypatch):
    c, _ = client
    monkeypatch.setitem(_main.service_state, "embed_model", None)
    async with c:
        r = await c.post("/tags/nearby", json={"query": "buses", "facets": ["topic"]})
    assert r.status_code == 200
    assert r.json() == {"facets": {"topic": []}, "model": r.json()["model"], "degraded": ["topic"]}


@pytest.mark.asyncio
async def test_blank_query_is_400(client):
    c, _ = client
    async with c:
        r = await c.post("/tags/nearby", json={"query": "   "})
    assert r.status_code == 400


def test_nearby_tags_top_k_override_keeps_setting_default(monkeypatch):
    # top_k=None must still read settings.topic_sense_top_k so /query's lanes
    # are byte-identical; an explicit top_k must win.
    import app.topic_sense as mod
    captured = {}

    class _Conn:
        def execute(self, sql, params):
            captured["k"] = params["k"]
            class _R:
                def fetchall(self_inner):
                    return [("A", 0.9), ("B", 0.8), ("C", 0.7), ("D", 0.6)]
            return _R()
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    class _Pool:
        def connection(self):
            return _Conn()

    monkeypatch.setattr("app.db.get_pool", lambda: _Pool())

    class _S:
        embedding_model = "cohere-embed-v4"
        topic_sense_top_k = 3
        topic_sense_min_cosine = 0.30

    monkeypatch.setattr("app.config.get_settings", lambda: _S())
    assert len(mod.nearby_tags([0.0] * 1536, "topic")) == 3
    assert len(mod.nearby_tags([0.0] * 1536, "topic", top_k=10)) == 4
    assert captured["k"] == 40
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_tags_nearby.py -v`
Expected: FAIL — 404 on `/tags/nearby` and `TypeError: nearby_tags() got an unexpected keyword argument 'top_k'`.

- [ ] **Step 3: Add `top_k` to `nearby_tags`**

Replace the function in `search-service/app/topic_sense.py`:

```python
def nearby_tags(query_embedding, facet: str, top_k: int | None = None) -> list:
    """Semantic query→tag match for one facet. Returns [(label, cosine), ...]
    filtered by threshold + top_k (failure-soft, design §4.1).

    `top_k=None` keeps settings.topic_sense_top_k so /query's tag lanes are
    byte-identical; /tags/nearby (experts mode) passes an explicit value."""
    from app.config import get_settings
    from app.db import get_pool

    s = get_settings()
    k = s.topic_sense_top_k if top_k is None else int(top_k)
    qvec = np.array(query_embedding, dtype=np.float32)
    with get_pool().connection() as conn:
        rows = conn.execute(
            _TAG_SQL,
            {"q": qvec, "model": s.embedding_model, "facet": facet,
             "k": max(k * 4, 20)},
        ).fetchall()
    return filter_topics(
        [(label, float(cos)) for label, cos in rows],
        top_k=k,
        min_cosine=s.topic_sense_min_cosine,
    )
```

- [ ] **Step 4: Add the endpoint to `main.py`**

Insert after the `/health` handler (before `def make_dense_retriever`):

```python
class TagsNearbyRequest(BaseModel):
    """Experts mode (docs/superpowers/specs/2026-09-09-experts-mode-design.md §5.2).
    Additive: /query is untouched."""
    query: str
    facets: List[str] = ["topic"]
    top_k: int = 10


class TagsNearbyResponse(BaseModel):
    facets: Dict[str, List[Tuple[str, float]]]
    model: str
    degraded: List[str]


@app.post("/tags/nearby", response_model=TagsNearbyResponse)
async def tags_nearby(request: TagsNearbyRequest):
    """Query→nearest tags per facet via tag_embeddings cosine. One embedding
    call (LRU-cached with /query's), one indexed SELECT per facet. A facet
    failure degrades that facet to [] and names it; it never 500s."""
    from app import topic_sense
    from app.config import get_settings

    query = request.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    settings = get_settings()
    out: Dict[str, List[Tuple[str, float]]] = {f: [] for f in request.facets}
    degraded: List[str] = []
    embed_model = service_state.get("embed_model")
    if embed_model is None or not topic_sense.model_has_tag_embeddings(settings.embedding_model):
        return TagsNearbyResponse(facets=out, model=settings.embedding_model, degraded=list(request.facets))
    try:
        emb = await asyncio.to_thread(embed_model.get_query_embedding, query)
    except Exception as exc:  # noqa: BLE001 — never fail the caller on an embed error
        logger.warning(f"/tags/nearby embed degraded: {exc}")
        return TagsNearbyResponse(facets=out, model=settings.embedding_model, degraded=list(request.facets))
    for facet in request.facets:
        try:
            out[facet] = await asyncio.to_thread(topic_sense.nearby_tags, emb, facet, request.top_k)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"/tags/nearby {facet} degraded: {exc}")
            degraded.append(facet)
    return TagsNearbyResponse(facets=out, model=settings.embedding_model, degraded=degraded)
```

Check the `typing` import line at the top of `main.py` includes `Tuple`; add it if missing.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_tags_nearby.py tests/test_topic_sense.py tests/test_understanding_wiring.py -v`
Expected: PASS (existing topic-sense and wiring suites prove `/query` lanes are unchanged).

- [ ] **Step 6: Commit**

```bash
git add search-service/app/topic_sense.py search-service/app/main.py search-service/tests/test_tags_nearby.py
git commit -m "feat(search): additive /tags/nearby endpoint for experts mode"
```

---

### Task 2: Experts query log table

**Files:**
- Create: `src/db/migrations/1788000000000-ExpertsQueryLogs.ts`
- Create: `src/db/entities/ExpertsModeQueryLogs.entity.ts`
- Create: `src/db/queries/insertExpertsModeQueryLog.ts`
- Create: `src/app/api/experts-mode-query-logs/route.ts`
- Modify: `src/db/data-source.ts` (entities array), `src/db/migration-data-source.ts` (entities array)
- Test: `src/__tests__/experts-query-log.db.test.ts`

**Interfaces:**
- Produces: `insertExpertsModeQueryLog({query, mode, topTenPeople}) → Promise<ExpertsModeQueryLogs>`; `POST /api/experts-mode-query-logs` body `{query: string, mode: string, topTenPeople: string}` → 201.

- [ ] **Step 1: Write the failing db test**

```ts
// src/__tests__/experts-query-log.db.test.ts
/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { insertExpertsModeQueryLog } from '@/db/queries/insertExpertsModeQueryLog'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('experts_mode_query_logs', () => {
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })
  afterAll(async () => {
    await AppDataSource.query(
      `DELETE FROM experts_mode_query_logs WHERE query LIKE '__test_experts_%'`,
    )
    await AppDataSource.destroy()
  })

  it('inserts a row with mode and top ten people', async () => {
    const row = await insertExpertsModeQueryLog({
      query: '__test_experts_electric buses',
      mode: 'evidence',
      topTenPeople: JSON.stringify(['Xue, Lulu']),
    })
    expect(row.id).toBeGreaterThan(0)
    const [back] = await AppDataSource.query(
      `SELECT query, mode, top_ten_people AS "topTenPeople" FROM experts_mode_query_logs WHERE id = $1`,
      [row.id],
    )
    expect(back).toEqual({
      query: '__test_experts_electric buses',
      mode: 'evidence',
      topTenPeople: '["Xue, Lulu"]',
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/__tests__/experts-query-log.db.test.ts`
Expected: with `DATABASE_URL` set (local bootstrap), FAIL on module not found; without it, the suite skips — in that case also run `npx tsc --noEmit -p tsconfig.json` and expect an import error, which is the failing signal.

- [ ] **Step 3: Write migration, entity, insert, route**

```ts
// src/db/migrations/1788000000000-ExpertsQueryLogs.ts
import { MigrationInterface, QueryRunner } from 'typeorm'

// Experts mode (docs/superpowers/specs/2026-09-09-experts-mode-design.md §5.3):
// query log mirroring cite_mode_query_logs plus a `mode` column
// ('evidence' | 'topic_only'). App-owned; TypeORM entity ExpertsModeQueryLogs.
export class Migration1788000000000 implements MigrationInterface {
  name = 'Migration1788000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "experts_mode_query_logs" ("id" SERIAL NOT NULL, "query" text NOT NULL, "mode" text NOT NULL, "top_ten_people" text NOT NULL, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_experts_mode_query_logs" PRIMARY KEY ("id"))`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "experts_mode_query_logs"`)
  }
}
```

```ts
// src/db/entities/ExpertsModeQueryLogs.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm'

@Entity('experts_mode_query_logs')
export class ExpertsModeQueryLogs {
  @PrimaryGeneratedColumn()
  id!: number

  @Column('text')
  query!: string

  @Column('text')
  mode!: string

  @Column('text', { name: 'top_ten_people' })
  topTenPeople!: string

  @CreateDateColumn({ type: 'timestamptz' })
  timestamp!: Date
}
```

```ts
// src/db/queries/insertExpertsModeQueryLog.ts
import { AppDataSource } from '../data-source'
import { ExpertsModeQueryLogs } from '../entities/ExpertsModeQueryLogs.entity'

export async function insertExpertsModeQueryLog(
  data: Pick<ExpertsModeQueryLogs, 'query' | 'mode' | 'topTenPeople'>,
) {
  const repo = AppDataSource.getRepository(ExpertsModeQueryLogs)
  return repo.save(repo.create(data))
}
```

```ts
// src/app/api/experts-mode-query-logs/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../db/data-source'
import { insertExpertsModeQueryLog } from '../../../db/queries/insertExpertsModeQueryLog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  await initializeDatabase()
  try {
    const body = await req.json()
    const query = typeof body?.query === 'string' ? body.query.trim() : ''
    const mode = body?.mode === 'topic_only' ? 'topic_only' : 'evidence'
    const topTenPeople =
      typeof body?.topTenPeople === 'string' ? body.topTenPeople : '[]'
    if (!query) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 })
    }
    const record = await insertExpertsModeQueryLog({ query, mode, topTenPeople })
    return NextResponse.json(record, { status: 201 })
  } catch (error) {
    console.error('❌ Error inserting experts query log:', error)
    return NextResponse.json({ error: 'Error inserting query' }, { status: 500 })
  }
}
```

Add `ExpertsModeQueryLogs` to the `entities` array in both `src/db/data-source.ts` and `src/db/migration-data-source.ts` (import from `./entities/ExpertsModeQueryLogs.entity`).

- [ ] **Step 4: Run the migration locally and the test**

Run: `npm run migration:run`
Expected: `Migration1788000000000 has been executed successfully.`

Run: `npx jest src/__tests__/experts-query-log.db.test.ts`
Expected: PASS (or skip without a database; then `npx tsc --noEmit -p tsconfig.json` must pass).

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/1788000000000-ExpertsQueryLogs.ts src/db/entities/ExpertsModeQueryLogs.entity.ts src/db/queries/insertExpertsModeQueryLog.ts src/app/api/experts-mode-query-logs/route.ts src/db/data-source.ts src/db/migration-data-source.ts src/__tests__/experts-query-log.db.test.ts
git commit -m "feat(experts): experts_mode_query_logs table, entity, and log route"
```

---

### Task 3: Types and the works query

**Files:**
- Create: `src/lib/experts/types.ts`
- Create: `src/db/queries/expertsEvidence.ts`
- Test: `src/__tests__/experts-evidence.db.test.ts`

**Interfaces:**
- Produces: every type below; `loadSearchableWorks(): Promise<WorkRow[]>` returning one row per work with translations collapsed.

- [ ] **Step 1: Write the shared types**

```ts
// src/lib/experts/types.ts
// Experts mode — docs/superpowers/specs/2026-09-09-experts-mode-design.md
export type Tier = 'strong' | 'partial' | 'weak'

/** One WORK: an original searchable document plus its confirmed translations. */
export interface WorkRow {
  docId: string // original's external_id
  translations: string[] // external_ids of confirmed searchable translation rows
  title: string
  year: number | null
  type: string | null
  office: string | null // normalized on read (WRI México -> WRI Mexico)
  url: string | null
  /** Raw author strings in stored order: original's first, then translations' extras. */
  authorsRaw: string[]
  topics: string[] // accepted topic value_ids, union across rows
  geographies: string[] // accepted geography value_ids, union across rows
}

export interface MatchedTag {
  label: string
  cosine: number
  df: number
}

export interface RetrievedDoc {
  docId: string // as returned by /query (may be a translation's id)
  tier: Tier
  rank: number
}

export interface AuthorRef {
  key: string
  name: string
  org: boolean
  unverified?: boolean
}

export interface PersonTopic {
  label: string
  n: number
  matched: boolean
}

export interface PersonResult {
  key: string
  name: string
  office: string
  offices: Record<string, number>
  score: number
  evidence: {
    docs: number
    strong: number
    partial: number
    weak: number
    years: [number, number] | null
    corpusDocs: number
  }
  topics: PersonTopic[]
  docIds: string[]
  unverified?: boolean
}

export interface DocResult {
  docId: string
  title: string
  year: number | null
  type: string | null
  office: string | null
  tier: Tier | null
  url: string | null
  authors: AuthorRef[]
  topics: string[]
  geographies: string[]
  translations: string[]
}

export type RankMode = 'evidence' | 'topic_only'

export interface RankResult {
  mode: RankMode
  people: PersonResult[]
  totalPeople: number
  docs: Record<string, DocResult>
  organizations: { name: string; docs: number }[]
}

export interface ExpertsUnderstanding {
  matched_topics: MatchedTag[]
  matched_geographies: MatchedTag[]
  likely_off_topic: boolean
  suggestions: { type: string; text: string }[]
  degraded: string[]
}

export interface ExpertsResponse {
  ok: true
  query: string
  mode: RankMode
  understanding: ExpertsUnderstanding
  people: PersonResult[]
  total_people: number
  docs: Record<string, DocResult>
  organizations: { name: string; docs: number }[]
  usage: Record<string, unknown> | null
  timing: Record<string, number>
}

export interface ExpertsRequest {
  query: string
  excluded_topics?: string[]
  top_n?: number
}
```

- [ ] **Step 2: Write the failing db test**

```ts
// src/__tests__/experts-evidence.db.test.ts
/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { loadSearchableWorks } from '@/db/queries/expertsEvidence'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('loadSearchableWorks', () => {
  const stamp = Date.now()
  const origExt = `experts_orig_${stamp}`
  const trExt = `experts_tr_${stamp}`
  const withdrawnExt = `experts_withdrawn_${stamp}`
  let origId: string
  let trId: string
  let withdrawnId: string
  let topicId: string
  let geoId: string

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const ins = async (ext: string, status: string, authors: string, office: string) => {
      const [r] = await AppDataSource.query(
        `INSERT INTO documents (external_id, s3_key, title, title_en, status, authors, year_published, article_type, wri_primary_office)
         VALUES ($1, $2, 'T', 'T en', $3, $4, 2024, 'Report', $5) RETURNING id`,
        [ext, `documents/${ext}.pdf`, status, authors, office],
      )
      return r.id as string
    }
    origId = await ins(origExt, 'searchable', 'Xue, Lulu; Chen, Ke', 'WRI México')
    trId = await ins(trExt, 'searchable', 'Xue, Lulu; Traductor, Ana', 'WRI México')
    withdrawnId = await ins(withdrawnExt, 'withdrawn', 'Ghost, Casper', 'WRI Global')
    await AppDataSource.query(
      `INSERT INTO document_relations (document_id, related_document_id, relation_type, status, source)
       VALUES ($1, $2, 'translation_of', 'confirmed', 'human')`,
      [trId, origId],
    )
    const [t] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version) VALUES ('topic', '__experts_topic__', 'v1') RETURNING id`,
    )
    topicId = t.id
    const [g] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version) VALUES ('geography', '__experts_geo__', 'v1') RETURNING id`,
    )
    geoId = g.id
    // topic on the TRANSLATION only, geography on the original, one rejected topic on original
    await AppDataSource.query(
      `INSERT INTO document_tags (document_id, tag_id, source, status) VALUES ($1, $2, 'llm', 'accepted'), ($3, $4, 'llm', 'accepted'), ($3, $2, 'llm', 'rejected')`,
      [trId, topicId, origId, geoId],
    )
  })

  afterAll(async () => {
    await AppDataSource.query(`DELETE FROM document_relations WHERE document_id = $1`, [trId])
    await AppDataSource.query(`DELETE FROM document_tags WHERE document_id = ANY($1)`, [[origId, trId]])
    await AppDataSource.query(`DELETE FROM documents WHERE id = ANY($1)`, [[origId, trId, withdrawnId]])
    await AppDataSource.query(`DELETE FROM tags WHERE id = ANY($1)`, [[topicId, geoId]])
    await AppDataSource.destroy()
  })

  it('collapses a confirmed translation into its original work', async () => {
    const works = await loadSearchableWorks()
    const ids = works.map((w) => w.docId)
    expect(ids).toContain(origExt)
    expect(ids).not.toContain(trExt)
    expect(ids).not.toContain(withdrawnExt)
    const w = works.find((x) => x.docId === origExt)!
    expect(w.translations).toEqual([trExt])
    expect(w.authorsRaw).toEqual(['Xue, Lulu', 'Chen, Ke', 'Traductor, Ana'])
    expect(w.topics).toEqual(['__experts_topic__']) // accepted, from the translation; rejected excluded
    expect(w.geographies).toEqual(['__experts_geo__'])
    expect(w.office).toBe('WRI Mexico')
    expect(w.title).toBe('T en')
    expect(w.year).toBe(2024)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx jest src/__tests__/experts-evidence.db.test.ts`
Expected: FAIL (module not found) with a database; skip without one (then `npx tsc --noEmit -p tsconfig.json` fails on the import).

- [ ] **Step 4: Write the query**

```ts
// src/db/queries/expertsEvidence.ts
import { AppDataSource } from '../data-source'
import type { WorkRow } from '../../lib/experts/types'

/** Office spelling drift on the documents column (WRI México vs WRI Mexico).
 *  Normalized on read; the stored value is left alone (editors own it). */
export function normalizeOffice(office: string | null): string | null {
  if (!office) return null
  const trimmed = office.replace(/\s+/g, ' ').trim()
  if (/^wri m[ée]xico$/i.test(trimmed)) return 'WRI Mexico'
  return trimmed
}

/** Authors are `;`-separated (see parseAuthors in src/app/utils/utils.tsx —
 *  commas belong to the name). */
function splitAuthors(s: string | null): string[] {
  return (s || '')
    .split(';')
    .map((v) => v.trim())
    .filter(Boolean)
}

// One row per WORK. A confirmed translation whose original is also searchable
// folds into the original; a translation whose original is withdrawn stands
// alone. Tags are the accepted union across the work's rows.
const WORKS_SQL = `
  WITH tr AS (
    SELECT r.related_document_id AS original_id, r.document_id AS translation_id
    FROM document_relations r
    JOIN documents t ON t.id = r.document_id AND t.status = 'searchable'
    JOIN documents o ON o.id = r.related_document_id AND o.status = 'searchable'
    WHERE r.status = 'confirmed' AND r.relation_type = 'translation_of'
  ),
  originals AS (
    SELECT d.* FROM documents d
    WHERE d.status = 'searchable'
      AND NOT EXISTS (SELECT 1 FROM tr WHERE tr.translation_id = d.id)
  ),
  members AS (
    SELECT o.id AS work_id, o.id AS doc_id FROM originals o
    UNION ALL
    SELECT tr.original_id AS work_id, tr.translation_id AS doc_id FROM tr
  )
  SELECT o.external_id AS "docId",
         COALESCE(o.title_en, o.title, '') AS title,
         o.year_published AS year,
         o.article_type AS type,
         o.wri_primary_office AS office,
         o.url,
         o.authors AS "authorsOriginal",
         COALESCE((SELECT array_agg(t.external_id ORDER BY t.external_id)
                   FROM tr JOIN documents t ON t.id = tr.translation_id
                   WHERE tr.original_id = o.id), '{}') AS translations,
         COALESCE((SELECT array_agg(t.authors ORDER BY t.external_id)
                   FROM tr JOIN documents t ON t.id = tr.translation_id
                   WHERE tr.original_id = o.id AND t.authors IS NOT NULL), '{}') AS "authorsTranslations",
         COALESCE((SELECT array_agg(DISTINCT tg.value_id)
                   FROM members m JOIN document_tags dt ON dt.document_id = m.doc_id AND dt.status = 'accepted'
                   JOIN tags tg ON tg.id = dt.tag_id AND tg.facet = 'topic'
                   WHERE m.work_id = o.id), '{}') AS topics,
         COALESCE((SELECT array_agg(DISTINCT tg.value_id)
                   FROM members m JOIN document_tags dt ON dt.document_id = m.doc_id AND dt.status = 'accepted'
                   JOIN tags tg ON tg.id = dt.tag_id AND tg.facet = 'geography'
                   WHERE m.work_id = o.id), '{}') AS geographies
  FROM originals o
  ORDER BY o.external_id
`

interface RawWork {
  docId: string
  title: string
  year: number | null
  type: string | null
  office: string | null
  url: string | null
  authorsOriginal: string | null
  translations: string[]
  authorsTranslations: string[]
  topics: string[]
  geographies: string[]
}

export async function loadSearchableWorks(): Promise<WorkRow[]> {
  const rows: RawWork[] = await AppDataSource.query(WORKS_SQL)
  return rows.map((r) => {
    const authors = splitAuthors(r.authorsOriginal)
    const seen = new Set(authors)
    for (const extra of r.authorsTranslations) {
      for (const a of splitAuthors(extra)) {
        if (!seen.has(a)) {
          seen.add(a)
          authors.push(a)
        }
      }
    }
    return {
      docId: r.docId,
      translations: r.translations,
      title: r.title,
      year: r.year,
      type: r.type,
      office: normalizeOffice(r.office),
      url: r.url,
      authorsRaw: authors,
      topics: r.topics,
      geographies: r.geographies,
    }
  })
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/__tests__/experts-evidence.db.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/experts/types.ts src/db/queries/expertsEvidence.ts src/__tests__/experts-evidence.db.test.ts
git commit -m "feat(experts): shared types and works query with translation collapse"
```

---

### Task 4: Author keying

**Files:**
- Create: `src/lib/experts/authorKey.ts`
- Test: `src/lib/experts/__tests__/authorKey.test.ts`

**Interfaces:**
- Produces: `buildAuthorIndex(raws: string[]): AuthorIndex`; `resolveAuthor(raw: string, index: AuthorIndex): AuthorRef` (from `types.ts`); `isOrganization(raw: string): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/experts/__tests__/authorKey.test.ts
import {
  buildAuthorIndex,
  isOrganization,
  resolveAuthor,
} from '@/lib/experts/authorKey'

// The 25 variant pairs from wri/askwri#411 reduce to this shape: a CSV row
// stores `Given Family`, a worker row stores `Family, Given`.
const PAIRS: [string, string][] = [
  ['Anjali Mahendra', 'Mahendra, Anjali'],
  ['Madhav Pai', 'Pai, Madhav'],
  ['Su Song', 'Song, Su'],
  ['Ryan Sclar', 'Sclar, Ryan'],
  ['Claudia Adriazola-Steil', 'Adriazola-Steil, Claudia'],
  ['Xiangyi Li', 'Li, Xiangyi'],
  ['Raj Bhagat Palanichamy', 'Palanichamy, Raj Bhagat'],
  ['David Pérez-Barbosa', 'Pérez-Barbosa, David'],
  ['Alejandra Achury', 'Achury, Alejandra'],
]

describe('resolveAuthor', () => {
  const index = buildAuthorIndex([
    ...PAIRS.flat(),
    'García Córdoba, Nicolás',
    'Nicolás García Córdoba',
    'Hellen Njoki Wanjohi-Opil',
    'Amos,Albert',
    'Coalition for Urban Transitions',
    'Beard, Victoria A.',
  ])

  it.each(PAIRS)('collapses %s and %s to one key', (given, family) => {
    const a = resolveAuthor(given, index)
    const b = resolveAuthor(family, index)
    expect(a.key).toBe(b.key)
    expect(a.name).toBe(family) // display prefers the Family, Given form
    expect(a.org).toBe(false)
    expect(a.unverified).toBeFalsy()
  })

  it('keys on family + first given token', () => {
    expect(resolveAuthor('Beard, Victoria A.', index).key).toBe('beard, victoria')
  })

  it('resolves a compound family name through its comma-form sibling', () => {
    const a = resolveAuthor('Nicolás García Córdoba', index)
    expect(a.key).toBe('garcía córdoba, nicolás')
    expect(a.name).toBe('García Córdoba, Nicolás')
    expect(a.unverified).toBeFalsy()
  })

  it('flags an unsplit name with no sibling as unverified and keeps it as stored', () => {
    const a = resolveAuthor('Hellen Njoki Wanjohi-Opil', index)
    expect(a.org).toBe(false)
    expect(a.unverified).toBe(true)
    expect(a.name).toBe('Hellen Njoki Wanjohi-Opil')
    expect(a.key).toBe('wanjohi-opil, hellen')
  })

  it('repairs a comma without a space', () => {
    expect(resolveAuthor('Amos,Albert', index)).toMatchObject({
      key: 'amos, albert',
      name: 'Amos, Albert',
      org: false,
    })
  })

  it('detects organizations by keyword, never by word count', () => {
    expect(isOrganization('Coalition for Urban Transitions')).toBe(true)
    expect(isOrganization('World Resources Institute')).toBe(true)
    expect(isOrganization('Hellen Njoki Wanjohi-Opil')).toBe(false)
    const o = resolveAuthor('Coalition for Urban Transitions', index)
    expect(o).toEqual({
      key: 'coalition for urban transitions',
      name: 'Coalition for Urban Transitions',
      org: true,
    })
  })

  it('treats a single-token name as its own key', () => {
    expect(resolveAuthor('Madonna', index).key).toBe('madonna')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/lib/experts/__tests__/authorKey.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/lib/experts/authorKey.ts
// Experts mode author identity (spec §6). Stopgap until wri/askwri#411
// normalizes stored values; kept afterwards because residual variants exist.
import type { AuthorRef } from './types'

const ORG_RE =
  /\b(institute|center|centre|council|coalition|bank|ministry|agency|university|programme|program|initiative|partnership|association|foundation|wri|world resources|group|network|alliance)\b/i

export function isOrganization(raw: string): boolean {
  const s = clean(raw)
  return !s.includes(',') && ORG_RE.test(s)
}

/** Trim, collapse whitespace, and put a space after a bare comma ("Amos,Albert"). */
export function clean(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim()
}

interface CommaForm {
  raw: string
  family: string // as stored, case preserved
  givenFirst: string // lowercased first given token
}

export interface AuthorIndex {
  /** Every `Family, Given` string seen, for sibling lookup. */
  commaForms: CommaForm[]
  /** key -> preferred display name (the Family, Given form). */
  display: Map<string, string>
}

function keyOf(family: string, givenFirst: string): string {
  return givenFirst ? `${family.toLowerCase()}, ${givenFirst}` : family.toLowerCase()
}

function splitComma(s: string): { family: string; givenFirst: string } {
  const i = s.indexOf(',')
  const family = s.slice(0, i).trim()
  const given = s.slice(i + 1).trim()
  return { family, givenFirst: (given.split(' ')[0] || '').toLowerCase() }
}

export function buildAuthorIndex(raws: string[]): AuthorIndex {
  const commaForms: CommaForm[] = []
  const display = new Map<string, string>()
  for (const raw of raws) {
    const s = clean(raw)
    if (!s || !s.includes(',')) continue
    const { family, givenFirst } = splitComma(s)
    if (!family) continue
    commaForms.push({ raw: s, family, givenFirst })
    const k = keyOf(family, givenFirst)
    if (!display.has(k)) display.set(k, s)
  }
  return { commaForms, display }
}

export function resolveAuthor(raw: string, index: AuthorIndex): AuthorRef {
  const s = clean(raw)
  if (s.includes(',')) {
    const { family, givenFirst } = splitComma(s)
    const key = keyOf(family, givenFirst)
    return { key, name: index.display.get(key) ?? s, org: false }
  }
  if (isOrganization(s)) {
    return { key: s.toLowerCase(), name: s, org: true }
  }
  const tokens = s.split(' ')
  if (tokens.length === 1) {
    return { key: s.toLowerCase(), name: s, org: false }
  }
  // Unsplit personal name. Do not guess the family/given boundary: adopt a
  // sibling whose family name is a suffix of this string and whose first
  // given token is this string's first token (spec §6 step 4).
  const first = tokens[0].toLowerCase()
  const lower = s.toLowerCase()
  const sibling = index.commaForms.find(
    (c) =>
      c.givenFirst === first &&
      lower.endsWith(' ' + c.family.toLowerCase()),
  )
  if (sibling) {
    const key = keyOf(sibling.family, sibling.givenFirst)
    return { key, name: index.display.get(key) ?? sibling.raw, org: false }
  }
  const family = tokens[tokens.length - 1]
  return { key: keyOf(family, first), name: s, org: false, unverified: true }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/lib/experts/__tests__/authorKey.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/experts/authorKey.ts src/lib/experts/__tests__/authorKey.test.ts
git commit -m "feat(experts): author keying with sibling-form lookup and org detection"
```

---

### Task 5: Ranking

**Files:**
- Create: `src/lib/experts/rank.ts`
- Test: `src/lib/experts/__tests__/rank.test.ts`

**Interfaces:**
- Consumes: `WorkRow`, `RetrievedDoc`, `MatchedTag`, `buildAuthorIndex`, `resolveAuthor`.
- Produces:
  ```ts
  export interface RankOptions { works: WorkRow[]; retrieved: RetrievedDoc[]; matchedTopics: {label: string; cosine: number}[]; excludedTopics?: string[]; likelyOffTopic?: boolean; currentYear: number; topN?: number }
  export function specificity(df: number, n: number): number
  export function computeDf(works: WorkRow[]): Map<string, number>
  export function rank(opts: RankOptions): RankResult & { matchedTopics: MatchedTag[] }
  ```
  Constants exported: `TIER_W`, `POS_DECAY = 0.3`, `EVIDENCE_WEIGHT = 0.7`, `TOPIC_WEIGHT = 0.3`, `MAX_CANDIDATES = 300`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/experts/__tests__/rank.test.ts
import { rank, specificity, computeDf } from '@/lib/experts/rank'
import type { WorkRow, RetrievedDoc } from '@/lib/experts/types'

const work = (p: Partial<WorkRow> & { docId: string }): WorkRow => ({
  translations: [],
  title: p.docId,
  year: 2024,
  type: 'Report',
  office: 'WRI Global',
  url: null,
  authorsRaw: [],
  topics: [],
  geographies: [],
  ...p,
})

const WORKS: WorkRow[] = [
  work({ docId: 'd1', authorsRaw: ['Xue, Lulu', 'Chen, Ke'], topics: ['Buses', 'Hub'], office: 'WRI China', year: 2025 }),
  work({ docId: 'd2', authorsRaw: ['Xue, Lulu'], topics: ['Buses', 'Hub'], office: 'WRI China', year: 2018 }),
  work({ docId: 'd3', authorsRaw: ['Sclar, Ryan', 'Coalition for Urban Transitions'], topics: ['School Buses', 'Hub'], year: 2023 }),
  work({ docId: 'd4', authorsRaw: ['Lazer, Leah'], topics: ['Hub'], year: 2021 }),
  work({ docId: 'd5', authorsRaw: ['Ryan Sclar'], topics: ['School Buses'], year: 2024, translations: ['d5-es'] }),
]
const YEAR = 2026

describe('specificity and df', () => {
  it('computes df over works and ln(N/df)', () => {
    const df = computeDf(WORKS)
    expect(df.get('Hub')).toBe(4)
    expect(df.get('Buses')).toBe(2)
    expect(specificity(4, 5)).toBeCloseTo(Math.log(5 / 4), 6)
    expect(specificity(0, 5)).toBeCloseTo(Math.log(5), 6) // df floored at 1
  })
})

describe('rank — evidence mode', () => {
  const retrieved: RetrievedDoc[] = [
    { docId: 'd1', tier: 'strong', rank: 1 },
    { docId: 'd5-es', tier: 'partial', rank: 2 }, // translation id -> work d5
    { docId: 'd4', tier: 'weak', rank: 3 },
  ]
  const res = rank({ works: WORKS, retrieved, matchedTopics: [{ label: 'Buses', cosine: 0.6 }, { label: 'Hub', cosine: 0.5 }], currentYear: YEAR })

  it('ranks the strong first author highest and normalizes to 1', () => {
    expect(res.mode).toBe('evidence')
    expect(res.people[0]).toMatchObject({ key: 'xue, lulu', name: 'Xue, Lulu', score: 1 })
  })

  it('merges Given Family and Family, Given into one person and maps a translation hit to its work', () => {
    const sclar = res.people.find((p) => p.key === 'sclar, ryan')!
    expect(sclar.evidence).toMatchObject({ docs: 1, partial: 1, corpusDocs: 2 })
    expect(sclar.docIds).toEqual(['d5'])
    expect(res.docs.d5.tier).toBe('partial')
    expect(res.docs.d5.translations).toEqual(['d5-es'])
  })

  it('weights second authors and old docs down', () => {
    const chen = res.people.find((p) => p.key === 'chen, ke')!
    const xue = res.people.find((p) => p.key === 'xue, lulu')!
    // both authored d1 (strong, 2025): Chen is author 2 -> 1/(1+0.3) of Xue's evidence on that doc
    expect(chen.score).toBeLessThan(xue.score)
    expect(chen.evidence.docs).toBe(1)
  })

  it('excludes organizations from people and lists them separately', () => {
    expect(res.people.map((p) => p.key)).not.toContain('coalition for urban transitions')
    expect(res.organizations).toEqual([{ name: 'Coalition for Urban Transitions', docs: 1 }])
  })

  it('reports matched topics with df and flags them on people', () => {
    expect(res.matchedTopics).toEqual([
      { label: 'Buses', cosine: 0.6, df: 2 },
      { label: 'Hub', cosine: 0.5, df: 4 },
    ])
    const xue = res.people[0]
    expect(xue.topics.find((t) => t.label === 'Buses')).toEqual({ label: 'Buses', n: 2, matched: true })
  })

  it('includes tag-only candidates (no retrieved doc) via the topic term', () => {
    // d2's author is Xue (already in). Sclar has School Buses which is not matched.
    // Lazer authored only d4 (weak, retrieved). Chen appears via d1. So the
    // candidate from topic-space alone here is nobody new; assert the set.
    expect(res.people.map((p) => p.key).sort()).toEqual(['chen, ke', 'lazer, leah', 'sclar, ryan', 'xue, lulu'])
    expect(res.totalPeople).toBe(4)
  })

  it('honors excluded_topics for the topic term and matched list', () => {
    const r2 = rank({ works: WORKS, retrieved, matchedTopics: [{ label: 'Buses', cosine: 0.6 }, { label: 'Hub', cosine: 0.5 }], excludedTopics: ['Hub'], currentYear: YEAR })
    expect(r2.matchedTopics.map((t) => t.label)).toEqual(['Buses'])
  })

  it('caps the list at topN but keeps totalPeople', () => {
    const r3 = rank({ works: WORKS, retrieved, matchedTopics: [], currentYear: YEAR, topN: 2 })
    expect(r3.people).toHaveLength(2)
    expect(r3.totalPeople).toBe(4) // xue, chen (d1), sclar (d5 via d5-es), lazer (d4)
  })
})

describe('rank — topic_only mode', () => {
  it('falls back to topic space when nothing was retrieved', () => {
    const res = rank({ works: WORKS, retrieved: [], matchedTopics: [{ label: 'School Buses', cosine: 0.7 }], currentYear: YEAR })
    expect(res.mode).toBe('topic_only')
    expect(res.people[0].key).toBe('sclar, ryan')
    expect(res.people[0].score).toBe(1)
    expect(res.docs.d3.tier).toBeNull()
  })

  it('falls back when likely_off_topic even with retrieved docs', () => {
    const res = rank({ works: WORKS, retrieved: [{ docId: 'd4', tier: 'weak', rank: 1 }], matchedTopics: [{ label: 'Buses', cosine: 0.7 }], likelyOffTopic: true, currentYear: YEAR })
    expect(res.mode).toBe('topic_only')
    expect(res.people.map((p) => p.key)).toEqual(['xue, lulu', 'chen, ke'])
  })

  it('returns no people when both signals are empty', () => {
    const res = rank({ works: WORKS, retrieved: [], matchedTopics: [], currentYear: YEAR })
    expect(res.mode).toBe('topic_only')
    expect(res.people).toEqual([])
  })

  it('specificity keeps a hub topic from dominating the topic term', () => {
    const res = rank({ works: WORKS, retrieved: [], matchedTopics: [{ label: 'Hub', cosine: 0.9 }, { label: 'School Buses', cosine: 0.5 }], currentYear: YEAR })
    // Sclar: 2 School Buses docs (df 2, spec ln(5/2)=0.92) * 0.5 * (2/3) ≈ 0.305 + Hub (1 doc) 0.9*ln(5/4)*(1/3)=0.067 → 0.37
    // Xue: Hub 2 docs → 0.9*0.223*(2/3)=0.134
    expect(res.people[0].key).toBe('sclar, ryan')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/lib/experts/__tests__/rank.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/lib/experts/rank.ts
// Experts-mode ranking (spec §4). Pure: no I/O, no Date.now().
//
// PROTOTYPE DEFAULTS. Every constant below is a starting point, not a tuned
// value; no labeled query set exists yet (evaluation/experts/). Changing one
// re-orders every result list with no instrument to say whether that was an
// improvement — record a before/after on the labeled set when one exists.
import { buildAuthorIndex, resolveAuthor } from './authorKey'
import type {
  AuthorRef,
  DocResult,
  MatchedTag,
  PersonResult,
  RankResult,
  RetrievedDoc,
  Tier,
  WorkRow,
} from './types'

export const TIER_W: Record<Tier, number> = { strong: 1, partial: 0.5, weak: 0.15 }
export const POS_DECAY = 0.3 // pos_w = 1 / (1 + POS_DECAY * index)
export const EVIDENCE_WEIGHT = 0.7
export const TOPIC_WEIGHT = 0.3
export const MAX_CANDIDATES = 300
export const DEFAULT_TOP_N = 20
export const MAX_TOP_N = 50

export interface RankOptions {
  works: WorkRow[]
  retrieved: RetrievedDoc[]
  matchedTopics: { label: string; cosine: number }[]
  excludedTopics?: string[]
  likelyOffTopic?: boolean
  currentYear: number
  topN?: number
}

export function specificity(df: number, n: number): number {
  return Math.log(Math.max(n, 1) / Math.max(df, 1))
}

export function computeDf(works: WorkRow[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const w of works) for (const t of new Set(w.topics)) df.set(t, (df.get(t) ?? 0) + 1)
  return df
}

function recencyWeight(year: number | null, currentYear: number): number {
  if (year == null) return 0.7
  if (year >= currentYear - 3) return 1
  if (year >= currentYear - 7) return 0.85
  return 0.7
}

interface PersonAcc {
  ref: AuthorRef
  evidence: number
  topic: number
  docIds: Set<string> // retrieved works (evidence)
  tiers: Record<Tier, number>
  offices: Record<string, number>
  years: number[]
  topicCounts: Map<string, number> // over ALL the person's works
  corpusDocs: number
}

export function rank(opts: RankOptions): RankResult & { matchedTopics: MatchedTag[] } {
  const { works, currentYear } = opts
  const topN = Math.min(Math.max(opts.topN ?? DEFAULT_TOP_N, 1), MAX_TOP_N)
  const excluded = new Set(opts.excludedTopics ?? [])
  const N = works.length
  const df = computeDf(works)
  const matched: MatchedTag[] = opts.matchedTopics
    .filter((t) => !excluded.has(t.label))
    .map((t) => ({ label: t.label, cosine: t.cosine, df: df.get(t.label) ?? 0 }))
  const matchedLabels = new Set(matched.map((t) => t.label))

  // Work lookup, including translation ids -> original.
  const byId = new Map<string, WorkRow>()
  for (const w of works) {
    byId.set(w.docId, w)
    for (const tr of w.translations) byId.set(tr, w)
  }

  // Author resolution over the whole corpus (sibling lookup needs every form).
  const index = buildAuthorIndex(works.flatMap((w) => w.authorsRaw))
  const authorsOf = new Map<string, AuthorRef[]>()
  for (const w of works) authorsOf.set(w.docId, w.authorsRaw.map((r) => resolveAuthor(r, index)))

  // Retrieved works: best tier per work.
  const tierRank: Record<Tier, number> = { strong: 3, partial: 2, weak: 1 }
  const retrievedTier = new Map<string, Tier>()
  for (const r of opts.retrieved) {
    const w = byId.get(r.docId)
    if (!w) continue
    const cur = retrievedTier.get(w.docId)
    if (!cur || tierRank[r.tier] > tierRank[cur]) retrievedTier.set(w.docId, r.tier)
  }
  const mode: RankResult['mode'] =
    retrievedTier.size === 0 || opts.likelyOffTopic ? 'topic_only' : 'evidence'
  if (mode === 'topic_only') retrievedTier.clear()

  // Candidate works: retrieved first, then tagged by matched topics (best cosine first).
  const candidateIds: string[] = [...retrievedTier.keys()]
  const bestCos = (w: WorkRow) =>
    Math.max(0, ...matched.filter((t) => w.topics.includes(t.label)).map((t) => t.cosine))
  const tagged = works
    .filter((w) => !retrievedTier.has(w.docId) && w.topics.some((t) => matchedLabels.has(t)))
    .sort((a, b) => bestCos(b) - bestCos(a))
  for (const w of tagged) {
    if (candidateIds.length >= MAX_CANDIDATES) break
    candidateIds.push(w.docId)
  }

  // Corpus-wide per-person stats (corpusDocs, topic counts) — over every work.
  const corpusCount = new Map<string, number>()
  const topicCountsAll = new Map<string, Map<string, number>>()
  for (const w of works) {
    for (const a of authorsOf.get(w.docId)!) {
      if (a.org) continue
      corpusCount.set(a.key, (corpusCount.get(a.key) ?? 0) + 1)
      let tc = topicCountsAll.get(a.key)
      if (!tc) { tc = new Map(); topicCountsAll.set(a.key, tc) }
      for (const t of new Set(w.topics)) tc.set(t, (tc.get(t) ?? 0) + 1)
    }
  }

  const people = new Map<string, PersonAcc>()
  const orgs = new Map<string, { name: string; docs: number }>()
  const acc = (a: AuthorRef): PersonAcc => {
    let p = people.get(a.key)
    if (!p) {
      p = {
        ref: a, evidence: 0, topic: 0, docIds: new Set(),
        tiers: { strong: 0, partial: 0, weak: 0 }, offices: {}, years: [],
        topicCounts: topicCountsAll.get(a.key) ?? new Map(),
        corpusDocs: corpusCount.get(a.key) ?? 0,
      }
      people.set(a.key, p)
    }
    return p
  }

  for (const id of candidateIds) {
    const w = byId.get(id)!
    const tier = retrievedTier.get(w.docId) ?? null
    const authors = authorsOf.get(w.docId)!
    let personIndex = 0
    for (const a of authors) {
      if (a.org) {
        const o = orgs.get(a.key) ?? { name: a.name, docs: 0 }
        o.docs += 1
        orgs.set(a.key, o)
        continue
      }
      const p = acc(a)
      if (tier) {
        p.evidence += TIER_W[tier] * (1 / (1 + POS_DECAY * personIndex)) * recencyWeight(w.year, currentYear)
        p.docIds.add(w.docId)
        p.tiers[tier] += 1
        if (w.year != null) p.years.push(w.year)
        p.offices[w.office ?? 'Office unknown'] = (p.offices[w.office ?? 'Office unknown'] ?? 0) + 1
      }
      personIndex += 1
    }
  }
  // Topic term over every candidate person, using corpus-wide topic counts.
  for (const p of people.values()) {
    for (const t of matched) {
      const n = p.topicCounts.get(t.label) ?? 0
      if (n > 0) p.topic += t.cosine * specificity(t.df, N) * Math.min(n, 3) / 3
    }
    if (p.docIds.size === 0) {
      // topic-only person: office/years from their works on matched topics
      for (const w of works) {
        if (!w.topics.some((t) => matchedLabels.has(t))) continue
        if (!authorsOf.get(w.docId)!.some((a) => a.key === p.ref.key)) continue
        p.offices[w.office ?? 'Office unknown'] = (p.offices[w.office ?? 'Office unknown'] ?? 0) + 1
        if (w.year != null) p.years.push(w.year)
        p.docIds.add(w.docId)
      }
    }
  }

  const maxE = Math.max(0, ...[...people.values()].map((p) => p.evidence))
  const maxS = Math.max(0, ...[...people.values()].map((p) => p.topic))
  const scored = [...people.values()]
    .map((p) => {
      const e = maxE > 0 ? p.evidence / maxE : 0
      const s = maxS > 0 ? p.topic / maxS : 0
      const score = mode === 'evidence' ? EVIDENCE_WEIGHT * e + TOPIC_WEIGHT * s : s
      return { p, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.p.ref.name.localeCompare(b.p.ref.name))
  const maxScore = scored[0]?.score ?? 1

  const docs: Record<string, DocResult> = {}
  const addDoc = (id: string) => {
    if (docs[id]) return
    const w = byId.get(id)!
    docs[id] = {
      docId: w.docId, title: w.title, year: w.year, type: w.type, office: w.office,
      tier: retrievedTier.get(w.docId) ?? null, url: w.url,
      authors: authorsOf.get(w.docId)!, topics: w.topics, geographies: w.geographies,
      translations: w.translations,
    }
  }

  const results: PersonResult[] = scored.slice(0, topN).map(({ p, score }) => {
    const ids = [...p.docIds]
    ids.forEach(addDoc)
    const office = Object.entries(p.offices).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Office unknown'
    const topics = [...p.topicCounts.entries()]
      .map(([label, n]) => ({ label, n, matched: matchedLabels.has(label) }))
      .sort((a, b) => Number(b.matched) - Number(a.matched) || b.n - a.n || a.label.localeCompare(b.label))
    return {
      key: p.ref.key, name: p.ref.name, office, offices: p.offices,
      score: Number((score / maxScore).toFixed(4)),
      evidence: {
        docs: mode === 'evidence' ? p.docIds.size : 0,
        strong: p.tiers.strong, partial: p.tiers.partial, weak: p.tiers.weak,
        years: p.years.length ? [Math.min(...p.years), Math.max(...p.years)] : null,
        corpusDocs: p.corpusDocs,
      },
      topics, docIds: ids,
      ...(p.ref.unverified ? { unverified: true } : {}),
    }
  })

  return {
    mode, people: results, totalPeople: scored.length, docs,
    organizations: [...orgs.values()].sort((a, b) => b.docs - a.docs || a.name.localeCompare(b.name)),
    matchedTopics: matched,
  }
}
```

Note for the implementer: in `topic_only` mode `evidence.docs` is 0 by definition (nothing retrieved) while `docIds` lists the works on matched topics; the UI shows "N documents on these topics" in that mode (Task 10).

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/lib/experts/__tests__/rank.test.ts`
Expected: PASS. If the "specificity keeps a hub topic from dominating" case fails, print both scores and confirm the arithmetic in the test comment before touching weights; the test encodes the spec, not the code.

- [ ] **Step 5: Commit**

```bash
git add src/lib/experts/rank.ts src/lib/experts/__tests__/rank.test.ts
git commit -m "feat(experts): pure ranking with evidence + specificity-weighted topic term"
```

---

### Task 6: Peers

**Files:**
- Create: `src/lib/experts/peers.ts`
- Test: `src/lib/experts/__tests__/peers.test.ts`

**Interfaces:**
- Produces: `PEER_THRESHOLD = 4.5`; `peersOf(person: PersonResult, others: PersonResult[], matched: MatchedTag[], totalWorks: number): Peer[]` where `Peer = { key: string; name: string; shared: number; topics: string[] }`, sorted by `shared` desc, topics most-specific first.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/experts/__tests__/peers.test.ts
import { peersOf, PEER_THRESHOLD } from '@/lib/experts/peers'
import type { MatchedTag, PersonResult } from '@/lib/experts/types'

const person = (key: string, topics: Record<string, number>): PersonResult => ({
  key, name: key, office: 'WRI Global', offices: {}, score: 1,
  evidence: { docs: 0, strong: 0, partial: 0, weak: 0, years: null, corpusDocs: 0 },
  topics: Object.entries(topics).map(([label, n]) => ({ label, n, matched: true })),
  docIds: [],
})
const N = 201
const matched: MatchedTag[] = [
  { label: 'Hub', cosine: 0.9, df: 145 }, // spec ln(201/145)=0.33
  { label: 'School Buses', cosine: 0.5, df: 10 }, // spec 3.0
  { label: 'Buses', cosine: 0.6, df: 19 }, // spec 2.36
]

describe('peersOf', () => {
  it('weights shared topics by specificity and thresholds', () => {
    const a = person('a', { Hub: 5, 'School Buses': 2, Buses: 1 })
    const hubOnly = person('b', { Hub: 5 })
    const specific = person('c', { 'School Buses': 2 })
    const out = peersOf(a, [hubOnly, specific], matched, N)
    // b: min(5,5)*0.33 = 1.63 < threshold; c: 2*3.0 = 6.0 >= threshold
    expect(out.map((p) => p.key)).toEqual(['c'])
    expect(out[0].shared).toBeCloseTo(6.0, 1)
    expect(out[0].topics).toEqual(['School Buses'])
  })

  it('lists shared topics most-specific first and sorts peers by shared', () => {
    const a = person('a', { Hub: 3, 'School Buses': 1, Buses: 2 })
    const b = person('b', { Buses: 2, 'School Buses': 1, Hub: 3 }) // 2*2.36+1*3+3*0.33 = 8.7
    const c = person('c', { 'School Buses': 1, Buses: 1 }) // 3+2.36 = 5.36
    const out = peersOf(a, [b, c], matched, N)
    expect(out.map((p) => p.key)).toEqual(['b', 'c'])
    expect(out[0].topics).toEqual(['School Buses', 'Buses', 'Hub'])
  })

  it('never returns the person themself', () => {
    const a = person('a', { 'School Buses': 3 })
    expect(peersOf(a, [a], matched, N)).toEqual([])
  })

  it('exposes the prototype threshold', () => {
    expect(PEER_THRESHOLD).toBe(4.5)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/lib/experts/__tests__/peers.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/lib/experts/peers.ts
// Peers (spec §4.5): specificity-weighted shared matched topics. Shared by
// the page (graph highlight, "works alongside") — pure, no I/O.
import { specificity } from './rank'
import type { MatchedTag, PersonResult } from './types'

// PROTOTYPE DEFAULT (4.5 from the mockup). No labeled set yet; raising it
// empties the peer list for people with one matched topic, lowering it makes
// hub topics connect everyone again. Derive from labeled queries before tuning.
export const PEER_THRESHOLD = 4.5

export interface Peer {
  key: string
  name: string
  shared: number
  topics: string[]
}

export function peersOf(
  person: PersonResult,
  others: PersonResult[],
  matched: MatchedTag[],
  totalWorks: number,
): Peer[] {
  const mine = new Map(person.topics.map((t) => [t.label, t.n]))
  const spec = new Map(matched.map((t) => [t.label, specificity(t.df, totalWorks)]))
  const out: Peer[] = []
  for (const q of others) {
    if (q.key === person.key) continue
    let shared = 0
    const topics: string[] = []
    for (const t of q.topics) {
      const s = spec.get(t.label)
      const n = mine.get(t.label)
      if (s === undefined || !n || !t.n) continue
      shared += Math.min(n, t.n) * s
      topics.push(t.label)
    }
    if (shared >= PEER_THRESHOLD) {
      topics.sort((a, b) => (spec.get(b) ?? 0) - (spec.get(a) ?? 0))
      out.push({ key: q.key, name: q.name, shared, topics })
    }
  }
  return out.sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name))
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/lib/experts/__tests__/peers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/experts/peers.ts src/lib/experts/__tests__/peers.test.ts
git commit -m "feat(experts): specificity-weighted peers"
```

---

### Task 7: `/api/experts` route

**Files:**
- Create: `src/app/api/experts/route.ts`
- Test: `src/__tests__/experts-route.test.ts`

**Interfaces:**
- Consumes: `loadSearchableWorks`, `rank`, `CITE_PRESET`, `ExpertsRequest`/`ExpertsResponse` types.
- Produces: `POST /api/experts` per spec §5.1.

- [ ] **Step 1: Write the failing tests**

```ts
// src/__tests__/experts-route.test.ts
/**
 * @jest-environment node
 *
 * Contract tests for POST /api/experts. The search service is a mocked global
 * fetch (two calls: /query then /tags/nearby); the works query is stubbed.
 */
import { NextRequest } from 'next/server'
import type { WorkRow } from '@/lib/experts/types'

const WORKS: WorkRow[] = [
  { docId: 'd1', translations: [], title: 'Bus paper', year: 2025, type: 'Report', office: 'WRI China', url: 'https://x/1', authorsRaw: ['Xue, Lulu'], topics: ['Buses'], geographies: ['China'] },
  { docId: 'd2', translations: [], title: 'School bus', year: 2024, type: 'Report', office: 'WRI US', url: null, authorsRaw: ['Lazer, Leah'], topics: ['School Buses'], geographies: [] },
]

jest.mock('@/db/data-source', () => ({ initializeDatabase: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/db/queries/expertsEvidence', () => ({ loadSearchableWorks: jest.fn() }))

const { loadSearchableWorks } = jest.requireMock('@/db/queries/expertsEvidence')
let fetchMock: jest.SpyInstance
const ENV = { ...process.env }

function queryReply(docs: { doc_id: string; tier: string }[], extra: Record<string, unknown> = {}) {
  return {
    docs: docs.map((d, i) => ({ doc_id: d.doc_id, title: d.doc_id, content: '', score: 1 - i * 0.1, metadata: { doc_id: d.doc_id, relevance_tier: d.tier } })),
    total_results: docs.length, query: 'q', mode: 'cite', debug: {}, usage: { total_usd: 0.01 },
    query_understanding: { suggestions: [{ type: 'nearby_topic', text: 'Buses' }] }, likely_off_topic: false, ...extra,
  }
}
function tagsReply(topic: [string, number][], geography: [string, number][] = [], degraded: string[] = []) {
  return { facets: { topic, geography }, model: 'cohere-embed-v4', degraded }
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/experts/route')
  const res = await POST(new NextRequest('http://localhost/api/experts', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
  return { status: res.status, json: await res.json() }
}

beforeEach(() => {
  jest.resetModules()
  process.env = { ...ENV, SEARCH_SERVICE_URL: 'http://search:8000' }
  loadSearchableWorks.mockResolvedValue(WORKS)
  fetchMock = jest.spyOn(global, 'fetch')
})
afterEach(() => fetchMock.mockRestore())

describe('POST /api/experts', () => {
  it('calls /query with max_results 200 then /tags/nearby, and ranks', async () => {
    fetchMock
      .mockResolvedValueOnce(json(queryReply([{ doc_id: 'd1', tier: 'strong' }])))
      .mockResolvedValueOnce(json(tagsReply([['Buses', 0.66], ['School Buses', 0.5]], [['China', 0.4]])))
    const { status, json: body } = await post({ query: 'electric buses' })
    expect(status).toBe(200)
    const [queryUrl, queryInit] = fetchMock.mock.calls[0]
    expect(queryUrl).toBe('http://search:8000/query')
    const sent = JSON.parse(queryInit.body)
    expect(sent).toMatchObject({ query: 'electric buses', mode: 'cite', max_results: 200, rerank: true, vector_top_k: 500, bm25_top_k: 500, fusion_top_k: 500, rerank_top_n: 500 })
    const [tagsUrl, tagsInit] = fetchMock.mock.calls[1]
    expect(tagsUrl).toBe('http://search:8000/tags/nearby')
    expect(JSON.parse(tagsInit.body)).toEqual({ query: 'electric buses', facets: ['topic', 'geography'], top_k: 10 })
    expect(body.ok).toBe(true)
    expect(body.mode).toBe('evidence')
    expect(body.people[0]).toMatchObject({ key: 'xue, lulu', score: 1 })
    expect(body.understanding.matched_topics).toEqual([{ label: 'Buses', cosine: 0.66, df: 1 }, { label: 'School Buses', cosine: 0.5, df: 1 }])
    expect(body.understanding.matched_geographies).toEqual([{ label: 'China', cosine: 0.4, df: 1 }])
    expect(body.understanding.suggestions).toEqual([{ type: 'nearby_topic', text: 'Buses' }])
    expect(body.usage).toEqual({ total_usd: 0.01 })
    expect(Object.keys(body.timing)).toEqual(expect.arrayContaining(['query_ms', 'tags_ms', 'db_ms', 'rank_ms']))
  })

  it('degrades to evidence-only when /tags/nearby fails', async () => {
    fetchMock
      .mockResolvedValueOnce(json(queryReply([{ doc_id: 'd1', tier: 'strong' }])))
      .mockResolvedValueOnce(json({ error: 'boom' }, 500))
    const { status, json: body } = await post({ query: 'electric buses' })
    expect(status).toBe(200)
    expect(body.understanding.degraded).toEqual(['tags_nearby'])
    expect(body.understanding.matched_topics).toEqual([])
    expect(body.people[0].key).toBe('xue, lulu')
  })

  it('degrades to topic_only when /query fails', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(json(tagsReply([['School Buses', 0.7]])))
    const { status, json: body } = await post({ query: 'school buses' })
    expect(status).toBe(200)
    expect(body.mode).toBe('topic_only')
    expect(body.understanding.degraded).toEqual(['query'])
    expect(body.people[0].key).toBe('lazer, leah')
  })

  it('returns 502 when both upstreams fail', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'))
    const { status, json: body } = await post({ query: 'anything' })
    expect(status).toBe(502)
    expect(body.ok).toBe(false)
  })

  it('validates the body', async () => {
    expect((await post({ query: '   ' })).status).toBe(400)
    expect((await post({ query: 'x', top_n: 'lots' })).status).toBe(400)
    expect((await post({ query: 'x', excluded_topics: 'Buses' })).status).toBe(400)
  })

  it('threads excluded_topics into the ranking', async () => {
    fetchMock
      .mockResolvedValueOnce(json(queryReply([{ doc_id: 'd1', tier: 'strong' }])))
      .mockResolvedValueOnce(json(tagsReply([['Buses', 0.66], ['School Buses', 0.5]])))
    const { json: body } = await post({ query: 'buses', excluded_topics: ['Buses'] })
    expect(body.understanding.matched_topics.map((t: any) => t.label)).toEqual(['School Buses'])
  })

  it('returns 500 when the works query fails', async () => {
    loadSearchableWorks.mockRejectedValueOnce(new Error('db down'))
    fetchMock.mockResolvedValueOnce(json(queryReply([]))).mockResolvedValueOnce(json(tagsReply([])))
    expect((await post({ query: 'x' })).status).toBe(500)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/__tests__/experts-route.test.ts`
Expected: FAIL — cannot find module `@/app/api/experts/route`.

- [ ] **Step 3: Implement the route**

```ts
// src/app/api/experts/route.ts
// Experts mode orchestration (spec §3, §5.1). Sequential upstream calls so the
// second hits the query-embedding LRU cache; one works query; pure rank().
import { NextRequest, NextResponse } from 'next/server'
import { CITE_PRESET } from '@/config/retrieval'
import { initializeDatabase } from '@/db/data-source'
import { loadSearchableWorks } from '@/db/queries/expertsEvidence'
import { rank, DEFAULT_TOP_N, MAX_TOP_N } from '@/lib/experts/rank'
import type { ExpertsResponse, RetrievedDoc, Tier } from '@/lib/experts/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL || 'http://localhost:8000'
// Evidence coverage: the UI's CITE_PRESET.maxResults (25) is a list-length
// cap, not a relevance one; the experts evidence term needs every work that
// cleared the logit floor. The reranker window (rerank_candidates=100, 2 per
// doc) is the real ceiling — see spec §3.
const EVIDENCE_MAX_RESULTS = 200
const TOPIC_TOP_K = 10
const GEO_TOP_K = 3
const TIERS: Tier[] = ['strong', 'partial', 'weak']

interface QueryDoc { doc_id: string; metadata?: { doc_id?: string; relevance_tier?: string } }
interface QueryReply {
  docs: QueryDoc[]
  usage?: Record<string, unknown> | null
  query_understanding?: { suggestions?: { type: string; text: string }[] } | null
  likely_off_topic?: boolean
}
interface TagsReply { facets: Record<string, [string, number][]>; degraded: string[] }

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SEARCH_SERVICE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} ${res.status}`)
  return (await res.json()) as T
}

export async function POST(req: NextRequest) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
  }
  const query = typeof body?.query === 'string' ? body.query.trim() : ''
  if (!query) return NextResponse.json({ ok: false, error: 'query is required' }, { status: 400 })
  if (body.top_n !== undefined && !(Number.isInteger(body.top_n) && body.top_n >= 1 && body.top_n <= MAX_TOP_N)) {
    return NextResponse.json({ ok: false, error: `top_n must be an integer 1..${MAX_TOP_N}` }, { status: 400 })
  }
  if (body.excluded_topics !== undefined && !(Array.isArray(body.excluded_topics) && body.excluded_topics.every((t: unknown) => typeof t === 'string'))) {
    return NextResponse.json({ ok: false, error: 'excluded_topics must be a string array' }, { status: 400 })
  }
  const topN: number = body.top_n ?? DEFAULT_TOP_N
  const excludedTopics: string[] = body.excluded_topics ?? []
  const degraded: string[] = []
  const timing: Record<string, number> = {}

  // 1. Evidence.
  let retrieved: RetrievedDoc[] = []
  let usage: Record<string, unknown> | null = null
  let suggestions: { type: string; text: string }[] = []
  let likelyOffTopic = false
  let t0 = Date.now()
  try {
    const q = await postJson<QueryReply>('/query', {
      query, mode: 'cite', max_results: EVIDENCE_MAX_RESULTS, similarity_threshold: 0,
      include_metadata: true, rerank: true,
      vector_top_k: CITE_PRESET.denseTopK, bm25_top_k: CITE_PRESET.sparseTopK,
      rerank_top_n: CITE_PRESET.rerankTopN, fusion_top_k: CITE_PRESET.fusionTopK,
    })
    retrieved = (q.docs ?? []).flatMap((d, i) => {
      const tier = d.metadata?.relevance_tier as Tier | undefined
      const id = d.metadata?.doc_id ?? d.doc_id
      return tier && TIERS.includes(tier) && id ? [{ docId: id, tier, rank: i + 1 }] : []
    })
    usage = q.usage ?? null
    suggestions = q.query_understanding?.suggestions ?? []
    likelyOffTopic = q.likely_off_topic ?? false
  } catch (err) {
    console.warn('[experts] /query degraded:', err)
    degraded.push('query')
  }
  timing.query_ms = Date.now() - t0

  // 2. Topic space (after /query so the embedding cache is warm).
  let topics: [string, number][] = []
  let geographies: [string, number][] = []
  t0 = Date.now()
  try {
    const t = await postJson<TagsReply>('/tags/nearby', { query, facets: ['topic', 'geography'], top_k: TOPIC_TOP_K })
    topics = t.facets.topic ?? []
    geographies = (t.facets.geography ?? []).slice(0, GEO_TOP_K)
    for (const f of t.degraded ?? []) degraded.push(`tags_nearby:${f}`)
  } catch (err) {
    console.warn('[experts] /tags/nearby degraded:', err)
    degraded.push('tags_nearby')
  }
  timing.tags_ms = Date.now() - t0

  if (degraded.includes('query') && degraded.includes('tags_nearby')) {
    return NextResponse.json({ ok: false, error: 'search service unavailable' }, { status: 502 })
  }

  // 3. Works + rank.
  try {
    t0 = Date.now()
    await initializeDatabase()
    const works = await loadSearchableWorks()
    timing.db_ms = Date.now() - t0
    t0 = Date.now()
    const result = rank({
      works, retrieved,
      matchedTopics: topics.map(([label, cosine]) => ({ label, cosine })),
      excludedTopics, likelyOffTopic, currentYear: new Date().getFullYear(), topN,
    })
    timing.rank_ms = Date.now() - t0
    const geoDf = new Map<string, number>()
    for (const w of works) for (const g of new Set(w.geographies)) geoDf.set(g, (geoDf.get(g) ?? 0) + 1)
    const response: ExpertsResponse = {
      ok: true, query, mode: result.mode,
      understanding: {
        matched_topics: result.matchedTopics,
        matched_geographies: geographies.map(([label, cosine]) => ({ label, cosine, df: geoDf.get(label) ?? 0 })),
        likely_off_topic: likelyOffTopic, suggestions, degraded,
      },
      people: result.people, total_people: result.totalPeople, docs: result.docs,
      organizations: result.organizations, usage, timing,
    }
    return NextResponse.json(response)
  } catch (err) {
    console.error('[experts] failed:', err)
    return NextResponse.json({ ok: false, error: 'internal error' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/__tests__/experts-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/experts/route.ts src/__tests__/experts-route.test.ts
git commit -m "feat(experts): /api/experts orchestration route"
```

---

### Task 8: Seeded graph layout

**Files:**
- Modify: `package.json` (add `d3-force`, `@types/d3-force`)
- Create: `src/lib/experts/layout.ts`
- Test: `src/lib/experts/__tests__/layout.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LayoutNode { id: string; kind: 'person' | 'topic'; key: string; r: number; x: number; y: number }
  export interface LayoutLink { source: string; target: string; w: number }
  export function buildGraph(people: PersonResult[], matched: MatchedTag[]): { nodes: Omit<LayoutNode,'x'|'y'>[]; links: LayoutLink[] }
  export function computeLayout(people: PersonResult[], matched: MatchedTag[], width: number, height: number, seed?: number): { nodes: LayoutNode[]; links: LayoutLink[] }
  ```

- [ ] **Step 1: Install the dependency**

Run: `npm install d3-force@3.0.0`
Run: `npm install --save-dev @types/d3-force@3.0.10`
Expected: `package.json` gains both; lockfile updated.

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/experts/__tests__/layout.test.ts
import { buildGraph, computeLayout } from '@/lib/experts/layout'
import type { MatchedTag, PersonResult } from '@/lib/experts/types'

const p = (key: string, score: number, topics: Record<string, number>): PersonResult => ({
  key, name: key, office: 'WRI Global', offices: {}, score,
  evidence: { docs: 1, strong: 1, partial: 0, weak: 0, years: null, corpusDocs: 1 },
  topics: Object.entries(topics).map(([label, n]) => ({ label, n, matched: true })), docIds: [],
})
const people = [p('a', 1, { Buses: 3, Hub: 1 }), p('b', 0.5, { Hub: 2 }), p('c', 0.2, { Buses: 1 })]
const matched: MatchedTag[] = [{ label: 'Buses', cosine: 0.66, df: 19 }, { label: 'Hub', cosine: 0.3, df: 145 }]

describe('buildGraph', () => {
  it('creates person and topic nodes and weighted person->topic links', () => {
    const g = buildGraph(people, matched)
    expect(g.nodes.map((n) => n.id)).toEqual(['p:a', 'p:b', 'p:c', 't:Buses', 't:Hub'])
    expect(g.links).toEqual([
      { source: 'p:a', target: 't:Buses', w: 3 }, { source: 'p:a', target: 't:Hub', w: 1 },
      { source: 'p:b', target: 't:Hub', w: 2 }, { source: 'p:c', target: 't:Buses', w: 1 },
    ])
    const a = g.nodes.find((n) => n.id === 'p:a')!
    const c = g.nodes.find((n) => n.id === 'p:c')!
    expect(a.r).toBeGreaterThan(c.r)
  })
})

describe('computeLayout', () => {
  it('is deterministic for a fixed seed and keeps nodes inside the frame', () => {
    const one = computeLayout(people, matched, 900, 600, 7)
    const two = computeLayout(people, matched, 900, 600, 7)
    expect(one.nodes.map((n) => [n.x, n.y])).toEqual(two.nodes.map((n) => [n.x, n.y]))
    for (const n of one.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.x).toBeLessThanOrEqual(900)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.y).toBeLessThanOrEqual(600)
    }
  })

  it('changes with the seed', () => {
    const one = computeLayout(people, matched, 900, 600, 1)
    const two = computeLayout(people, matched, 900, 600, 2)
    expect(one.nodes.map((n) => n.x)).not.toEqual(two.nodes.map((n) => n.x))
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npx jest src/lib/experts/__tests__/layout.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Implement**

```ts
// src/lib/experts/layout.ts
// Static, seeded force layout (spec §8): computed once per result set, no
// animation. Radii and forces mirror the mockup.
import {
  forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
} from 'd3-force'
import type { MatchedTag, PersonResult } from './types'

export interface LayoutNode {
  id: string
  kind: 'person' | 'topic'
  key: string // person key or topic label
  r: number
  x: number
  y: number
}
export interface LayoutLink { source: string; target: string; w: number }

const TICKS = 360

/** Small deterministic PRNG (mulberry32) so layouts are reproducible. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function buildGraph(people: PersonResult[], matched: MatchedTag[]) {
  const nodes: Omit<LayoutNode, 'x' | 'y'>[] = []
  const links: LayoutLink[] = []
  for (const p of people) nodes.push({ id: `p:${p.key}`, kind: 'person', key: p.key, r: 7 + 13 * p.score })
  const maxCos = Math.max(0.01, ...matched.map((t) => t.cosine))
  for (const t of matched) nodes.push({ id: `t:${t.label}`, kind: 'topic', key: t.label, r: 9 + 18 * (t.cosine / maxCos) })
  const matchedSet = new Set(matched.map((t) => t.label))
  for (const p of people) {
    for (const t of p.topics) {
      if (matchedSet.has(t.label) && t.n > 0) links.push({ source: `p:${p.key}`, target: `t:${t.label}`, w: t.n })
    }
  }
  return { nodes, links }
}

export function computeLayout(people: PersonResult[], matched: MatchedTag[], width: number, height: number, seed = 1) {
  const g = buildGraph(people, matched)
  type SimNode = LayoutNode & { vx?: number; vy?: number }
  const nodes: SimNode[] = g.nodes.map((n) => ({ ...n, x: width / 2, y: height / 2 }))
  const links = g.links.map((l) => ({ ...l }))
  const sim = forceSimulation<SimNode>(nodes)
    .randomSource(mulberry32(seed))
    .force('link', forceLink<SimNode, { source: string; target: string; w: number }>(links as any).id((d) => d.id)
      .distance((l) => 96 - 8 * Math.min(l.w, 5)).strength((l) => 0.25 + 0.1 * Math.min(l.w, 4)))
    .force('charge', forceManyBody<SimNode>().strength((d) => (d.kind === 'topic' ? -900 : -260)))
    .force('collide', forceCollide<SimNode>().radius((d) => d.r + (d.kind === 'topic' ? 48 : 34)).iterations(2))
    .force('center', forceCenter(width / 2, height / 2))
    .force('x', forceX(width / 2).strength(0.05))
    .force('y', forceY(height / 2).strength(0.07))
    .stop()
  for (let i = 0; i < TICKS; i += 1) sim.tick()
  const out: LayoutNode[] = nodes.map((n) => ({
    id: n.id, kind: n.kind, key: n.key, r: n.r,
    x: Math.max(n.r + 70, Math.min(width - n.r - 110, n.x)),
    y: Math.max(n.r + 16, Math.min(height - n.r - 16, n.y)),
  }))
  return { nodes: out, links: g.links }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx jest src/lib/experts/__tests__/layout.test.ts`
Expected: PASS. If Jest fails to parse `d3-force` (ESM), add to `jest.config.js` `customJestConfig`: `transformIgnorePatterns: ['/node_modules/(?!(d3-force|d3-quadtree|d3-dispatch|d3-timer)/)']` and re-run.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/experts/layout.ts src/lib/experts/__tests__/layout.test.ts jest.config.js
git commit -m "feat(experts): seeded d3-force layout"
```

---

### Task 9: Client helper and experts suggestions

**Files:**
- Create: `src/lib/experts-client.ts`
- Modify: `src/app/components/QuerySuggestions/types.tsx`, `suggestionPool.ts`, `index.tsx`
- Test: `src/lib/__tests__/experts-client.test.ts`, `src/app/components/QuerySuggestions/__tests__/pool.test.ts`

**Interfaces:**
- Produces: `fetchExperts(req: ExpertsRequest): Promise<ExpertsResponse>` (throws `Error` with the server's `error` string on non-2xx); `EXPERTS_MODE_SUGGESTION_POOL`; `QuerySuggestionsProps.mode: 'cite' | 'answer' | 'experts'`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/__tests__/experts-client.test.ts
/** @jest-environment node */
import { fetchExperts } from '@/lib/experts-client'

describe('fetchExperts', () => {
  afterEach(() => jest.restoreAllMocks())

  it('posts the request and returns the body', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, people: [] }), { status: 200 }))
    const out = await fetchExperts({ query: 'buses', excluded_topics: ['Hub'] })
    expect(spy).toHaveBeenCalledWith('/api/experts', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse((spy.mock.calls[0][1] as any).body)).toEqual({ query: 'buses', excluded_topics: ['Hub'] })
    expect(out).toEqual({ ok: true, people: [] })
  })

  it('throws the server error on non-2xx', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'search service unavailable' }), { status: 502 }))
    await expect(fetchExperts({ query: 'x' })).rejects.toThrow('search service unavailable')
  })
})
```

```ts
// src/app/components/QuerySuggestions/__tests__/pool.test.ts
import { EXPERTS_MODE_SUGGESTION_POOL, getRandomSuggestions } from '../suggestionPool'

describe('experts suggestion pool', () => {
  it('has at least six people-shaped prompts', () => {
    expect(EXPERTS_MODE_SUGGESTION_POOL.length).toBeGreaterThanOrEqual(6)
    for (const s of EXPERTS_MODE_SUGGESTION_POOL) expect(s).not.toMatch(/\?$/) // topics, not questions
  })
  it('draws from the experts pool', () => {
    const out = getRandomSuggestions(3, 'experts')
    expect(out).toHaveLength(3)
    for (const s of out) expect(EXPERTS_MODE_SUGGESTION_POOL).toContain(s)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/lib/__tests__/experts-client.test.ts src/app/components/QuerySuggestions/__tests__/pool.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/experts-client.ts
import type { ExpertsRequest, ExpertsResponse } from './experts/types'

export async function fetchExperts(req: ExpertsRequest): Promise<ExpertsResponse> {
  const res = await fetch('/api/experts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `experts request failed (${res.status})`)
  return body as ExpertsResponse
}
```

In `src/app/components/QuerySuggestions/types.tsx`:

```ts
export interface QuerySuggestionsProps {
  mode: 'cite' | 'answer' | 'experts'
  onExampleClick: (example: string) => void
}
```

In `suggestionPool.ts`, add after `ANSWER_MODE_SUGGESTION_POOL`:

```ts
export const EXPERTS_MODE_SUGGESTION_POOL = [
  'Electric school buses',
  'Compact urban growth in India',
  'Nature-based solutions in Brazilian cities',
  'Land value capture',
  'Zero-emission freight in China',
  'Informal settlements and climate resilience',
  'Bus rapid transit financing',
  'Road safety for pedestrians',
]
```

and change `getRandomSuggestions`:

```ts
export const getRandomSuggestions = (
  count = 3,
  mode: 'cite' | 'answer' | 'experts' = 'cite',
) => {
  const pool = [
    ...(mode === 'cite'
      ? CITE_MODE_SUGGESTION_POOL
      : mode === 'experts'
        ? EXPERTS_MODE_SUGGESTION_POOL
        : ANSWER_MODE_SUGGESTION_POOL),
  ]
  // ...rest unchanged
```

In `index.tsx`, replace the `pool` selection and the explainer text:

```tsx
import {
  ANSWER_MODE_SUGGESTION_POOL,
  CITE_MODE_SUGGESTION_POOL,
  EXPERTS_MODE_SUGGESTION_POOL,
  getRandomSuggestions,
} from './suggestionPool'
// ...
  const pool =
    mode === 'cite'
      ? CITE_MODE_SUGGESTION_POOL
      : mode === 'experts'
        ? EXPERTS_MODE_SUGGESTION_POOL
        : ANSWER_MODE_SUGGESTION_POOL
// ...
        {mode === 'experts'
          ? 'Name a topic, method, or place. Results are people whose published WRI work is closest to it.'
          : 'For best results, ask a direct question and experiment with different levels of specificity, including geography.'}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/lib/__tests__/experts-client.test.ts src/app/components/QuerySuggestions`
Expected: PASS (existing QuerySuggestions tests included).

- [ ] **Step 5: Commit**

```bash
git add src/lib/experts-client.ts src/lib/__tests__/experts-client.test.ts src/app/components/QuerySuggestions
git commit -m "feat(experts): client helper and experts suggestion pool"
```

---

### Task 10: List, chips, evidence, organizations components

**Files:**
- Create: `src/app/components/Experts/Experts.css`
- Create: `src/app/components/Experts/officeColor.ts`
- Create: `src/app/components/Experts/TopicChips.tsx`
- Create: `src/app/components/Experts/ExpertsList.tsx`
- Create: `src/app/components/Experts/ExpertEvidence.tsx`
- Create: `src/app/components/Experts/OrganizationsStrip.tsx`
- Test: `src/app/components/Experts/__tests__/ExpertsList.test.tsx`, `src/app/components/Experts/__tests__/ExpertEvidence.test.tsx`, `src/app/components/Experts/__tests__/TopicChips.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  officeColor(office: string | null): string           // hex per spec §8 (Global blue, China orange, India green, else neutral)
  <TopicChips topics={MatchedTag[]} geographies={MatchedTag[]} onRemove={(label: string) => void} />
  <ExpertsList people={PersonResult[]} mode={RankMode} selectedKey={string|null} peerKeys={Set<string>} onHover={(key: string|null) => void} onSelect={(key: string) => void} />
  <ExpertEvidence person={PersonResult} docs={Record<string, DocResult>} peers={Peer[]} mode={RankMode} matched={MatchedTag[]} onSelectPeer={(key: string) => void} onClose={() => void} />
  <OrganizationsStrip organizations={{name: string; docs: number}[]} />
  ```

- [ ] **Step 1: Write the failing tests**

```tsx
// src/app/components/Experts/__tests__/ExpertsList.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { ExpertsList } from '../ExpertsList'
import type { PersonResult } from '@/lib/experts/types'

const person = (key: string, name: string, office: string, score: number): PersonResult => ({
  key, name, office, offices: { [office]: 2 }, score,
  evidence: { docs: 6, strong: 4, partial: 2, weak: 0, years: [2019, 2025], corpusDocs: 27 },
  topics: [{ label: 'Buses', n: 5, matched: true }, { label: 'Hub', n: 6, matched: false }, { label: 'School Buses', n: 1, matched: true }],
  docIds: ['d1'],
})
const people = [person('xue, lulu', 'Xue, Lulu', 'WRI China', 1), person('sclar, ryan', 'Sclar, Ryan', 'WRI Global', 0.6)]

describe('ExpertsList', () => {
  it('renders rank, name, office, evidence line, and matched topics only', () => {
    render(<ChakraProvider><ExpertsList people={people} mode='evidence' selectedKey={null} peerKeys={new Set()} onHover={jest.fn()} onSelect={jest.fn()} /></ChakraProvider>)
    expect(screen.getByText('Xue, Lulu')).toBeInTheDocument()
    expect(screen.getAllByText('WRI China')[0]).toBeInTheDocument()
    expect(screen.getByText(/6 docs · 4 strong · 2 partial · 2019–2025/)).toBeInTheDocument()
    expect(screen.getAllByText(/Buses/)[0]).toBeInTheDocument()
    expect(screen.queryByText(/^Hub/)).not.toBeInTheDocument()
  })

  it('hover and click call back with the key; selected and peer rows are marked', () => {
    const onHover = jest.fn()
    const onSelect = jest.fn()
    render(<ChakraProvider><ExpertsList people={people} mode='evidence' selectedKey='xue, lulu' peerKeys={new Set(['sclar, ryan'])} onHover={onHover} onSelect={onSelect} /></ChakraProvider>)
    const row = screen.getByRole('button', { name: /Sclar, Ryan/ })
    fireEvent.mouseEnter(row)
    expect(onHover).toHaveBeenCalledWith('sclar, ryan')
    fireEvent.mouseLeave(row)
    expect(onHover).toHaveBeenLastCalledWith(null)
    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledWith('sclar, ryan')
    expect(screen.getByRole('button', { name: /Xue, Lulu/ })).toHaveAttribute('aria-pressed', 'true')
    expect(row).toHaveAttribute('data-peer', 'true')
  })

  it('shows topic-only wording when mode is topic_only', () => {
    const p = { ...people[0], evidence: { ...people[0].evidence, docs: 0, strong: 0, partial: 0 }, docIds: ['d1', 'd2'] }
    render(<ChakraProvider><ExpertsList people={[p]} mode='topic_only' selectedKey={null} peerKeys={new Set()} onHover={jest.fn()} onSelect={jest.fn()} /></ChakraProvider>)
    expect(screen.getByText(/2 docs on these topics/)).toBeInTheDocument()
  })
})
```

```tsx
// src/app/components/Experts/__tests__/ExpertEvidence.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { ExpertEvidence } from '../ExpertEvidence'
import type { DocResult, PersonResult } from '@/lib/experts/types'

const person: PersonResult = {
  key: 'xue, lulu', name: 'Xue, Lulu', office: 'WRI China', offices: { 'WRI China': 2, 'WRI Global': 1 }, score: 1,
  evidence: { docs: 2, strong: 1, partial: 1, weak: 0, years: [2021, 2025], corpusDocs: 27 },
  topics: [{ label: 'Buses', n: 2, matched: true }, { label: 'Hub', n: 3, matched: false }], docIds: ['d1', 'd2'],
}
const docs: Record<string, DocResult> = {
  d1: { docId: 'd1', title: 'Older partial', year: 2021, type: 'Report', office: 'WRI China', tier: 'partial', url: 'https://x/1', authors: [{ key: 'chen, ke', name: 'Chen, Ke', org: false }, { key: 'xue, lulu', name: 'Xue, Lulu', org: false }], topics: ['Buses'], geographies: [], translations: [] },
  d2: { docId: 'd2', title: 'Newer strong', year: 2025, type: 'Working Paper', office: 'WRI China', tier: 'strong', url: null, authors: [{ key: 'xue, lulu', name: 'Xue, Lulu', org: false }], topics: ['Buses', 'Hub'], geographies: ['China'], translations: ['d2-es'] },
}

describe('ExpertEvidence', () => {
  it('shows offices, concentration, docs by tier then year, author position, and translations', () => {
    render(<ChakraProvider><ExpertEvidence person={person} docs={docs} peers={[{ key: 'chen, ke', name: 'Chen, Ke', shared: 5, topics: ['Buses'] }]} mode='evidence' matched={[{ label: 'Buses', cosine: 0.6, df: 19 }]} onSelectPeer={jest.fn()} onClose={jest.fn()} /></ChakraProvider>)
    expect(screen.getByRole('heading', { name: 'Xue, Lulu' })).toBeInTheDocument()
    expect(screen.getByText(/WRI China \(2\), WRI Global \(1\)/)).toBeInTheDocument()
    expect(screen.getByText(/2 of 27 documents match/)).toBeInTheDocument()
    const titles = screen.getAllByTestId('evidence-doc-title').map((n) => n.textContent)
    expect(titles).toEqual(['Newer strong', 'Older partial'])
    expect(screen.getByText(/author 2 of 2/)).toBeInTheDocument()
    expect(screen.getByText(/also in 1 translation/)).toBeInTheDocument()
  })

  it('peer click and close call back', () => {
    const onSelectPeer = jest.fn()
    const onClose = jest.fn()
    render(<ChakraProvider><ExpertEvidence person={person} docs={docs} peers={[{ key: 'chen, ke', name: 'Chen, Ke', shared: 5, topics: ['Buses'] }]} mode='evidence' matched={[]} onSelectPeer={onSelectPeer} onClose={onClose} /></ChakraProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Chen, Ke' }))
    expect(onSelectPeer).toHaveBeenCalledWith('chen, ke')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })
})
```

```tsx
// src/app/components/Experts/__tests__/TopicChips.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { TopicChips } from '../TopicChips'

describe('TopicChips', () => {
  it('renders topics with strength and geographies, and removes a topic', () => {
    const onRemove = jest.fn()
    render(<ChakraProvider><TopicChips topics={[{ label: 'Buses', cosine: 0.66, df: 19 }]} geographies={[{ label: 'China', cosine: 0.41, df: 49 }]} onRemove={onRemove} /></ChakraProvider>)
    expect(screen.getByText('Buses')).toBeInTheDocument()
    expect(screen.getByText('0.66')).toBeInTheDocument()
    expect(screen.getByText('China')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Buses' }))
    expect(onRemove).toHaveBeenCalledWith('Buses')
  })
  it('renders nothing when there are no matches', () => {
    const { container } = render(<TopicChips topics={[]} geographies={[]} onRemove={jest.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/app/components/Experts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the components**

```css
/* src/app/components/Experts/Experts.css */
.experts-row { border-left: 3px solid transparent; }
.experts-row:hover { background: rgba(240, 171, 0, 0.16); }
.experts-row[aria-pressed='true'] { background: rgba(240, 171, 0, 0.16); border-left-color: #1b1a17; }
.experts-row[data-peer='true'] { background: rgba(240, 171, 0, 0.07); }
.experts-row:focus-visible { outline: 2px solid #1b1a17; outline-offset: -2px; }
.experts-peer-btn { border: 0; background: none; cursor: pointer; padding: 0; font: inherit; font-weight: 500; text-align: left; }
.experts-peer-btn:hover { text-decoration: underline; }
.experts-chip-x { border: 0; background: none; cursor: pointer; padding: 0 2px; line-height: 1; }
```

```ts
// src/app/components/Experts/officeColor.ts
// Three validated colorblind-safe hues (dataviz palette slots 1-3, all-pairs
// pass) for the three offices that are 80% of the corpus; everything else is
// one neutral. The exact office is always in text beside the color (spec §8).
export const OFFICE_COLORS: Record<string, string> = {
  'WRI Global': '#2a78d6',
  'WRI China': '#eb6834',
  'WRI India': '#1baf7a',
}
export const OTHER_OFFICE_COLOR = '#8A877E'
export const ACCENT = '#B8800A'
export const ACCENT_WASH = 'rgba(240, 171, 0, 0.34)'
export const INK = '#1b1a17'

export function officeColor(office: string | null): string {
  return (office && OFFICE_COLORS[office]) || OTHER_OFFICE_COLOR
}
```

```tsx
// src/app/components/Experts/TopicChips.tsx
'use client'

import type { MatchedTag } from '@/lib/experts/types'
import { ACCENT } from './officeColor'
import './Experts.css'

// Sibling of InterpretationLine (spec §7): same idiom, plus a strength slot.
export const TopicChips = ({
  topics, geographies, onRemove,
}: { topics: MatchedTag[]; geographies: MatchedTag[]; onRemove: (label: string) => void }) => {
  if (topics.length === 0 && geographies.length === 0) return null
  const chip = (t: MatchedTag, removable: boolean) => (
    <span key={`${removable ? 't' : 'g'}:${t.label}`} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999, padding: '3px 8px 3px 10px',
      fontSize: 12.5, border: `1px solid ${removable ? ACCENT : '#D6D1C2'}`,
      background: removable ? 'rgba(240,171,0,0.16)' : 'white',
    }}>
      {t.label}
      <span style={{ fontSize: 11, color: '#8A877E', fontVariantNumeric: 'tabular-nums' }}>{t.cosine.toFixed(2)}</span>
      {removable && (
        <button type='button' className='experts-chip-x' aria-label={`Remove ${t.label}`} onClick={() => onRemove(t.label)}>✕</button>
      )}
    </span>
  )
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, color: '#5E5B52' }}>
      <span>Reading your query as</span>
      {topics.map((t) => chip(t, true))}
      {geographies.map((g) => chip(g, false))}
    </div>
  )
}
```

```tsx
// src/app/components/Experts/ExpertsList.tsx
'use client'

import type { PersonResult, RankMode } from '@/lib/experts/types'
import { ACCENT, ACCENT_WASH, officeColor } from './officeColor'
import './Experts.css'

export function yearsLabel(years: [number, number] | null): string {
  if (!years) return ''
  return years[0] === years[1] ? String(years[0]) : `${years[0]}–${years[1]}`
}

export function evidenceLine(p: PersonResult, mode: RankMode): string {
  const yr = yearsLabel(p.evidence.years)
  if (mode === 'topic_only') {
    const n = p.docIds.length
    return `${n} doc${n === 1 ? '' : 's'} on these topics${yr ? ' · ' + yr : ''}`
  }
  const parts: string[] = []
  if (p.evidence.strong) parts.push(`${p.evidence.strong} strong`)
  if (p.evidence.partial) parts.push(`${p.evidence.partial} partial`)
  if (p.evidence.weak) parts.push(`${p.evidence.weak} weak`)
  return `${p.evidence.docs} doc${p.evidence.docs === 1 ? '' : 's'} · ${parts.join(' · ')}${yr ? ' · ' + yr : ''}`
}

export const ExpertsList = ({
  people, mode, selectedKey, peerKeys, onHover, onSelect,
}: {
  people: PersonResult[]
  mode: RankMode
  selectedKey: string | null
  peerKeys: Set<string>
  onHover: (key: string | null) => void
  onSelect: (key: string) => void
}) => (
  <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
    {people.map((p, i) => (
      <li key={p.key}>
        <button
          type='button'
          className='experts-row'
          id={`expert-row-${encodeURIComponent(p.key)}`}
          aria-pressed={selectedKey === p.key}
          data-peer={peerKeys.has(p.key) ? 'true' : 'false'}
          onMouseEnter={() => onHover(p.key)}
          onMouseLeave={() => onHover(null)}
          onFocus={() => onHover(p.key)}
          onBlur={() => onHover(null)}
          onClick={() => onSelect(p.key)}
          style={{
            width: '100%', textAlign: 'left', background: 'none', border: 0, borderBottom: '1px solid #E6E2D6',
            display: 'grid', gridTemplateColumns: '28px 1fr', columnGap: 10, padding: '12px 6px 12px 4px', cursor: 'pointer', font: 'inherit',
          }}
        >
          <span style={{ fontVariantNumeric: 'tabular-nums', color: '#8A877E', fontSize: 12, paddingTop: 3 }}>{i + 1}</span>
          <span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: 14.5 }}>{p.name}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#5E5B52' }}>
                <i aria-hidden='true' style={{ width: 8, height: 8, borderRadius: '50%', background: officeColor(p.office), display: 'inline-block' }} />
                {p.office}
              </span>
              {p.unverified && <span style={{ fontSize: 11, color: '#8A877E' }}>name as stored</span>}
            </span>
            <span aria-hidden='true' style={{ display: 'block', height: 3, background: '#E6E2D6', borderRadius: 2, margin: '7px 0 6px', overflow: 'hidden' }}>
              <i style={{ display: 'block', height: '100%', width: `${Math.round(p.score * 100)}%`, background: ACCENT }} />
            </span>
            <span style={{ display: 'block', fontSize: 12.5, color: '#5E5B52', fontVariantNumeric: 'tabular-nums' }}>{evidenceLine(p, mode)}</span>
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
              {p.topics.filter((t) => t.matched).slice(0, 3).map((t) => (
                <span key={t.label} style={{ fontSize: 11.5, padding: '1px 7px', borderRadius: 3, background: ACCENT_WASH, color: '#7A5400' }}>
                  {t.label} <span style={{ opacity: 0.7 }}>{t.n}</span>
                </span>
              ))}
            </span>
          </span>
        </button>
      </li>
    ))}
  </ol>
)
```

```tsx
// src/app/components/Experts/ExpertEvidence.tsx
'use client'

import { Button } from '@worldresources/wri-design-systems'
import type { Peer } from '@/lib/experts/peers'
import type { DocResult, MatchedTag, PersonResult, RankMode } from '@/lib/experts/types'
import { ACCENT_WASH } from './officeColor'
import { yearsLabel } from './ExpertsList'
import './Experts.css'

const TIER_ORDER = { strong: 3, partial: 2, weak: 1 } as const

export const ExpertEvidence = ({
  person, docs, peers, mode, matched, onSelectPeer, onClose,
}: {
  person: PersonResult
  docs: Record<string, DocResult>
  peers: Peer[]
  mode: RankMode
  matched: MatchedTag[]
  onSelectPeer: (key: string) => void
  onClose: () => void
}) => {
  const matchedSet = new Set(matched.map((t) => t.label))
  const offices = Object.entries(person.offices).sort((a, b) => b[1] - a[1]).map(([o, n]) => `${o} (${n})`).join(', ')
  const list = person.docIds.map((id) => docs[id]).filter(Boolean)
    .sort((a, b) => (TIER_ORDER[b.tier ?? 'weak'] ?? 0) - (TIER_ORDER[a.tier ?? 'weak'] ?? 0) || (b.year ?? 0) - (a.year ?? 0))
  const matchLine = mode === 'evidence'
    ? `${person.evidence.docs} of ${person.evidence.corpusDocs} documents match`
    : `${person.docIds.length} of ${person.evidence.corpusDocs} documents are on these topics`
  return (
    <aside aria-live='polite' style={{ marginTop: 16, background: 'white', border: '1px solid #E6E2D6', borderRadius: 6, padding: '16px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{person.name}</h3>
          <div style={{ color: '#5E5B52', fontSize: 13, marginTop: 2 }}>{offices} · {matchLine} · {yearsLabel(person.evidence.years)}</div>
        </div>
        <Button variant='borderless' size='small' onClick={onClose}>Close</Button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18, marginTop: 14 }}>
        <div>
          <h4 style={{ margin: '0 0 8px', fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#8A877E', fontWeight: 600 }}>
            {mode === 'evidence' ? `Evidence · ${person.evidence.strong} strong, ${person.evidence.partial} partial, ${person.evidence.weak} weak` : 'Documents on these topics'}
          </h4>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {list.map((d) => {
              const pos = d.authors.findIndex((a) => a.key === person.key) + 1
              return (
                <li key={d.docId} style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 10, padding: '7px 0', borderTop: '1px solid #E6E2D6' }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '2px 6px', borderRadius: 3, textAlign: 'center', background: d.tier === 'strong' ? ACCENT_WASH : d.tier === 'partial' ? 'rgba(240,171,0,0.16)' : '#E6E2D6', color: d.tier ? '#7A5400' : '#5E5B52' }}>
                    {d.tier ?? 'topic'}
                  </span>
                  <span>
                    <div data-testid='evidence-doc-title' style={{ fontSize: 13, lineHeight: 1.35 }}>
                      {d.url ? <a href={d.url} target='_blank' rel='noopener noreferrer'>{d.title}</a> : d.title}
                    </div>
                    <div style={{ fontSize: 12, color: '#8A877E', fontVariantNumeric: 'tabular-nums' }}>
                      {[d.year, d.type, d.office].filter(Boolean).join(' · ')} · author {pos} of {d.authors.length}
                      {d.translations.length > 0 && ` · also in ${d.translations.length} translation${d.translations.length === 1 ? '' : 's'}`}
                    </div>
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
        <div>
          <h4 style={{ margin: '0 0 8px', fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#8A877E', fontWeight: 600 }}>Works alongside</h4>
          {peers.length === 0 && <div style={{ fontSize: 13, color: '#8A877E' }}>No one else in this list shares their specific topics.</div>}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {peers.slice(0, 6).map((q) => (
              <li key={q.key} style={{ padding: '6px 0', borderTop: '1px solid #E6E2D6', display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                <button type='button' className='experts-peer-btn' onClick={() => onSelectPeer(q.key)}>{q.name}</button>
                <span style={{ color: '#8A877E', fontSize: 12, whiteSpace: 'nowrap' }}>
                  {q.topics.slice(0, 2).join(', ')}{q.topics.length > 2 ? ` +${q.topics.length - 2}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <h4 style={{ margin: '16px 0 8px', fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#8A877E', fontWeight: 600 }}>All topics on their documents</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {person.topics.slice(0, 14).map((t) => (
              <span key={t.label} style={{ fontSize: 11.5, padding: '1px 7px', borderRadius: 3, background: matchedSet.has(t.label) ? ACCENT_WASH : '#E6E2D6', color: matchedSet.has(t.label) ? '#7A5400' : '#5E5B52' }}>
                {t.label} {t.n}
              </span>
            ))}
          </div>
        </div>
      </div>
    </aside>
  )
}
```

```tsx
// src/app/components/Experts/OrganizationsStrip.tsx
'use client'

export const OrganizationsStrip = ({ organizations }: { organizations: { name: string; docs: number }[] }) => {
  if (organizations.length === 0) return null
  return (
    <p style={{ padding: '10px 4px', fontSize: 12.5, color: '#5E5B52' }}>
      Also publishing on this:{' '}
      {organizations.slice(0, 5).map((o, i) => (
        <span key={o.name}>{i > 0 && ', '}{o.name} ({o.docs} doc{o.docs === 1 ? '' : 's'})</span>
      ))}
    </p>
  )
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/app/components/Experts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/Experts
git commit -m "feat(experts): list, topic chips, evidence panel, organizations strip"
```

---

### Task 11: Topic graph component

**Files:**
- Create: `src/app/components/Experts/TopicGraph.tsx`
- Test: `src/app/components/Experts/__tests__/TopicGraph.test.tsx`

**Interfaces:**
- Consumes: `computeLayout`, `officeColor`.
- Produces: `<TopicGraph people matched totalWorks hoverKey selectedKey peerKeys onHover onSelect onHoverTopic hint />` where `hoverKey`/`selectedKey` are person keys or null, `hoverTopic` handling is internal, and the parent owns highlight state. Renders `svg[role=img]` plus a hint line.

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/components/Experts/__tests__/TopicGraph.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { TopicGraph } from '../TopicGraph'
import type { MatchedTag, PersonResult } from '@/lib/experts/types'

const p = (key: string, name: string, score: number, office: string, topics: Record<string, number>): PersonResult => ({
  key, name, office, offices: {}, score,
  evidence: { docs: 1, strong: 1, partial: 0, weak: 0, years: null, corpusDocs: 1 },
  topics: Object.entries(topics).map(([label, n]) => ({ label, n, matched: true })), docIds: [],
})
const people = Array.from({ length: 10 }, (_, i) => p(`k${i}`, `Person ${i}`, 1 - i * 0.08, 'WRI Global', { Buses: 1 }))
const matched: MatchedTag[] = [{ label: 'Buses', cosine: 0.66, df: 19 }]

describe('TopicGraph', () => {
  it('renders every person and topic node; labels people ranked > 8 as quiet', () => {
    render(<TopicGraph people={people} matched={matched} totalWorks={201} hoverKey={null} selectedKey={null} peerKeys={new Set()} onHover={jest.fn()} onSelect={jest.fn()} />)
    expect(screen.getByRole('img')).toBeInTheDocument()
    expect(screen.getAllByTestId('person-node')).toHaveLength(10)
    expect(screen.getAllByTestId('topic-node')).toHaveLength(1)
    const quiet = screen.getAllByTestId('person-label').filter((n) => n.getAttribute('data-quiet') === 'true')
    expect(quiet).toHaveLength(2)
  })

  it('marks focus, peers, dim; hover and click call back', () => {
    const onHover = jest.fn()
    const onSelect = jest.fn()
    render(<TopicGraph people={people} matched={matched} totalWorks={201} hoverKey={null} selectedKey='k0' peerKeys={new Set(['k1'])} onHover={onHover} onSelect={onSelect} />)
    const nodes = screen.getAllByTestId('person-node')
    expect(nodes[0]).toHaveAttribute('data-state', 'focus')
    expect(nodes[1]).toHaveAttribute('data-state', 'peer')
    expect(nodes[2]).toHaveAttribute('data-state', 'dim')
    fireEvent.mouseEnter(nodes[2])
    expect(onHover).toHaveBeenCalledWith('k2')
    fireEvent.click(nodes[2])
    expect(onSelect).toHaveBeenCalledWith('k2')
    expect(screen.getByTestId('graph-hint').textContent).toMatch(/Person 0/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/app/components/Experts/__tests__/TopicGraph.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// src/app/components/Experts/TopicGraph.tsx
'use client'

import { useMemo, useState } from 'react'
import { computeLayout } from '@/lib/experts/layout'
import type { MatchedTag, PersonResult } from '@/lib/experts/types'
import { ACCENT, ACCENT_WASH, INK, officeColor } from './officeColor'

const W = 940
const H = 760
const LABEL_AT_REST = 8
const REST_HINT = 'Hover a person to see their topics and who else works in them. Click to pin and open the evidence. Names for people ranked 9–20 appear on hover.'

function shortName(n: string): string {
  const [fam, giv] = n.split(', ')
  return giv ? `${giv.split(' ')[0]} ${fam}` : fam
}

type NodeState = 'rest' | 'focus' | 'peer' | 'dim' | 'on'

export const TopicGraph = ({
  people, matched, totalWorks, hoverKey, selectedKey, peerKeys, onHover, onSelect,
}: {
  people: PersonResult[]
  matched: MatchedTag[]
  totalWorks: number
  hoverKey: string | null
  selectedKey: string | null
  peerKeys: Set<string>
  onHover: (key: string | null) => void
  onSelect: (key: string) => void
}) => {
  const [hoverTopic, setHoverTopic] = useState<string | null>(null)
  const layout = useMemo(() => computeLayout(people, matched, W, H, 7), [people, matched])
  const byId = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout])
  const personByKey = useMemo(() => new Map(people.map((p) => [p.key, p])), [people])

  const active = selectedKey ?? hoverKey
  const activeTopics = new Set(active ? (personByKey.get(active)?.topics.filter((t) => t.matched).map((t) => t.label) ?? []) : [])
  const withTopic = new Set(hoverTopic && !active ? people.filter((p) => p.topics.some((t) => t.label === hoverTopic && t.n > 0)).map((p) => p.key) : [])

  const personState = (key: string): NodeState => {
    if (active) return key === active ? 'focus' : peerKeys.has(key) ? 'peer' : 'dim'
    if (hoverTopic) return withTopic.has(key) ? 'peer' : 'dim'
    return 'rest'
  }
  const topicState = (label: string): NodeState => {
    if (active) return activeTopics.has(label) ? 'on' : 'dim'
    if (hoverTopic) return label === hoverTopic ? 'on' : 'dim'
    return 'rest'
  }
  const edgeState = (source: string, target: string): NodeState => {
    const pk = source.slice(2)
    const tl = target.slice(2)
    if (active) {
      if (pk === active) return 'on'
      if (peerKeys.has(pk) && activeTopics.has(tl)) return 'peer'
      return 'dim'
    }
    if (hoverTopic) return tl === hoverTopic ? 'on' : 'dim'
    return 'rest'
  }

  let hint = REST_HINT
  if (active && personByKey.get(active)) {
    const p = personByKey.get(active)!
    const n = p.topics.filter((t) => t.matched).length
    hint = `${shortName(p.name)} · ${n} matched topic${n === 1 ? '' : 's'} · shares topics with ${peerKeys.size} other ranked ${peerKeys.size === 1 ? 'person' : 'people'} (highlighted)`
  } else if (hoverTopic) {
    hint = `${hoverTopic} · ${withTopic.size} of the ${people.length} shown people have documents tagged with it`
  }

  const opacityFor = (s: NodeState) => (s === 'dim' ? 0.16 : 1)
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} role='img' aria-label={`${people.length} people connected to the ${matched.length} topics that match the query`} style={{ display: 'block', width: '100%', height: 'auto' }}>
        <g>
          {layout.links.map((l) => {
            const s = byId.get(l.source)!
            const t = byId.get(l.target)!
            const st = edgeState(l.source, l.target)
            return (
              <line key={`${l.source}-${l.target}`} x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                stroke={st === 'on' || st === 'peer' ? ACCENT : '#C9C4B4'} strokeOpacity={st === 'dim' ? 0.12 : st === 'peer' ? 0.35 : 1}
                strokeWidth={0.8 + 0.7 * Math.min(l.w, 5)} />
            )
          })}
        </g>
        <g>
          {layout.nodes.filter((n) => n.kind === 'topic').map((n) => {
            const st = topicState(n.key)
            return (
              <g key={n.id} data-testid='topic-node' transform={`translate(${n.x},${n.y})`} opacity={opacityFor(st)} style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHoverTopic(n.key)} onMouseLeave={() => setHoverTopic(null)}>
                <circle r={Math.max(n.r + 8, 16)} fill='transparent' />
                <circle r={n.r} fill={st === 'on' ? ACCENT_WASH : 'white'} stroke={ACCENT} strokeWidth={2} />
                <text textAnchor='middle' y={n.r + 13} fontSize={11} fontWeight={600} fill={st === 'on' ? '#7A5400' : '#5E5B52'} style={{ pointerEvents: 'none' }}>{n.key}</text>
              </g>
            )
          })}
          {layout.nodes.filter((n) => n.kind === 'person').map((n) => {
            const p = personByKey.get(n.key)!
            const rankIndex = people.indexOf(p)
            const st = personState(n.key)
            const quiet = rankIndex >= LABEL_AT_REST && st !== 'focus' && st !== 'peer' && hoverKey !== n.key
            const label = shortName(p.name)
            const pillW = label.length * 6.6 + 10
            return (
              <g key={n.id} data-testid='person-node' data-state={st} transform={`translate(${n.x},${n.y})`} opacity={opacityFor(st)} style={{ cursor: 'pointer' }}
                onMouseEnter={() => onHover(n.key)} onMouseLeave={() => onHover(null)} onClick={() => onSelect(n.key)}>
                <circle r={Math.max(n.r + 8, 16)} fill='transparent' />
                {st === 'focus' && selectedKey === n.key && <circle r={n.r + 6} fill='none' stroke={INK} strokeWidth={2.5} />}
                <circle r={n.r} fill={officeColor(p.office)} stroke={st === 'peer' ? ACCENT : 'white'} strokeWidth={st === 'peer' ? 1.5 : 2} />
                {st === 'focus' && selectedKey === n.key && <rect x={n.r + 4} y={-9} width={pillW} height={18} rx={3} fill={INK} />}
                <text data-testid='person-label' data-quiet={quiet ? 'true' : 'false'} x={n.r + 9} y={4} fontSize={11.5} fontWeight={st === 'focus' ? 700 : 500}
                  fill={st === 'focus' && selectedKey === n.key ? '#FBFAF6' : INK} opacity={quiet ? 0 : 1} style={{ pointerEvents: 'none' }}>{label}</text>
              </g>
            )
          })}
        </g>
      </svg>
      <div data-testid='graph-hint' style={{ padding: '8px 14px 10px', fontSize: 12, color: '#8A877E', borderTop: '1px solid #E6E2D6' }}>{hint}</div>
    </div>
  )
}
```

`totalWorks` is accepted for the legend/aria description and future peer wiring; the parent computes `peerKeys` with `peersOf` (Task 12).

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/app/components/Experts/__tests__/TopicGraph.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/Experts/TopicGraph.tsx src/app/components/Experts/__tests__/TopicGraph.test.tsx
git commit -m "feat(experts): SVG topic graph with hover, peer, and selected states"
```

---

### Task 12: The `/experts` page

**Files:**
- Create: `src/app/experts/page.tsx`
- Test: `src/__tests__/experts-page.test.tsx`

**Interfaces:**
- Consumes: `fetchExperts`, `peersOf`, all `Experts/*` components, `Navbar`, `QuerySuggestions`, `EmptyStateTopics`, design-system `Textarea`, `Button`, `AlertBanner`, `InlineMessage`, `Tag`.
- Produces: route `/experts` with URL state `?q=&person=&exclude=`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/__tests__/experts-page.test.tsx
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ExpertsPage from '@/app/experts/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { fetchExperts } from '@/lib/experts-client'
import type { ExpertsResponse } from '@/lib/experts/types'

const params = new Map<string, string>()
const routerPush = jest.fn()
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/experts',
  useSearchParams: () => ({ get: (k: string) => params.get(k) ?? null, toString: () => '' }),
}))
jest.mock('@/lib/experts-client', () => ({ fetchExperts: jest.fn() }))
jest.mock('@/app/components/Experts/TopicGraph', () => ({ TopicGraph: (p: any) => <div data-testid='graph' data-selected={p.selectedKey ?? ''} data-hover={p.hoverKey ?? ''} /> }))
const mockFetch = fetchExperts as jest.Mock

const response = (over: Partial<ExpertsResponse> = {}): ExpertsResponse => ({
  ok: true, query: 'electric buses', mode: 'evidence',
  understanding: { matched_topics: [{ label: 'Buses', cosine: 0.66, df: 19 }], matched_geographies: [], likely_off_topic: false, suggestions: [], degraded: [] },
  people: [
    { key: 'xue, lulu', name: 'Xue, Lulu', office: 'WRI China', offices: { 'WRI China': 3 }, score: 1, evidence: { docs: 3, strong: 2, partial: 1, weak: 0, years: [2020, 2025], corpusDocs: 27 }, topics: [{ label: 'Buses', n: 3, matched: true }], docIds: ['d1'] },
    { key: 'sclar, ryan', name: 'Sclar, Ryan', office: 'WRI Global', offices: { 'WRI Global': 1 }, score: 0.5, evidence: { docs: 1, strong: 1, partial: 0, weak: 0, years: [2021, 2021], corpusDocs: 8 }, topics: [{ label: 'Buses', n: 2, matched: true }], docIds: ['d2'] },
  ],
  total_people: 2,
  docs: {
    d1: { docId: 'd1', title: 'Bus paper', year: 2025, type: 'Report', office: 'WRI China', tier: 'strong', url: null, authors: [{ key: 'xue, lulu', name: 'Xue, Lulu', org: false }], topics: ['Buses'], geographies: [], translations: [] },
    d2: { docId: 'd2', title: 'Other', year: 2021, type: 'Report', office: 'WRI Global', tier: 'strong', url: null, authors: [{ key: 'sclar, ryan', name: 'Sclar, Ryan', org: false }], topics: ['Buses'], geographies: [], translations: [] },
  },
  organizations: [{ name: 'Coalition for Urban Transitions', docs: 9 }], usage: null, timing: {}, ...over,
})

beforeEach(() => {
  params.clear()
  routerPush.mockClear()
  mockFetch.mockReset()
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 201 })) // query log
})
afterEach(() => jest.restoreAllMocks())

const renderPage = () => render(<ChakraProvider><ExpertsPage /></ChakraProvider>)

describe('/experts page', () => {
  it('idle: shows the staff banner, suggestions, and submits to ?q=', () => {
    renderPage()
    expect(screen.getByText(/For WRI staff use only/)).toBeInTheDocument()
    const input = screen.getByLabelText('Expertise query input')
    fireEvent.change(input, { target: { value: 'electric buses' } })
    fireEvent.click(screen.getByLabelText('Find people'))
    expect(routerPush).toHaveBeenCalledWith('/experts?q=electric%20buses')
  })

  it('results: renders list, chips, summary, organizations; selecting opens evidence and updates URL', async () => {
    params.set('q', 'electric buses')
    mockFetch.mockResolvedValue(response())
    renderPage()
    await waitFor(() => expect(screen.getByText('Xue, Lulu')).toBeInTheDocument())
    expect(mockFetch).toHaveBeenCalledWith({ query: 'electric buses', excluded_topics: [] })
    expect(screen.getByText(/2 people across 2 offices/)).toBeInTheDocument()
    expect(screen.getByText(/Coalition for Urban Transitions/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Xue, Lulu/ }))
    expect(await screen.findByRole('heading', { name: 'Xue, Lulu' })).toBeInTheDocument()
    expect(screen.getByTestId('graph')).toHaveAttribute('data-selected', 'xue, lulu')
    expect(routerPush).toHaveBeenLastCalledWith('/experts?q=electric%20buses&person=xue%2C%20lulu')
  })

  it('logs the query once after results', async () => {
    params.set('q', 'electric buses')
    mockFetch.mockResolvedValue(response())
    renderPage()
    await waitFor(() => expect(screen.getByText('Xue, Lulu')).toBeInTheDocument())
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/experts-mode-query-logs', expect.objectContaining({ method: 'POST' })))
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    expect(body).toEqual({ query: 'electric buses', mode: 'evidence', topTenPeople: JSON.stringify(['Xue, Lulu', 'Sclar, Ryan']) })
  })

  it('removing a topic chip re-queries with excluded_topics and updates URL', async () => {
    params.set('q', 'electric buses')
    mockFetch.mockResolvedValue(response())
    renderPage()
    await waitFor(() => expect(screen.getByText('Xue, Lulu')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Remove Buses' }))
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith({ query: 'electric buses', excluded_topics: ['Buses'] }))
    expect(routerPush).toHaveBeenLastCalledWith('/experts?q=electric%20buses&exclude=Buses')
  })

  it('topic_only: shows the silent-corpus banner', async () => {
    params.set('q', 'quantum transit')
    mockFetch.mockResolvedValue(response({ mode: 'topic_only', query: 'quantum transit' }))
    renderPage()
    expect(await screen.findByText(/No direct matches for “quantum transit”/)).toBeInTheDocument()
  })

  it('nothing: shows the empty state with nearby topics', async () => {
    params.set('q', 'zzz')
    mockFetch.mockResolvedValue(response({ mode: 'topic_only', people: [], total_people: 0, docs: {}, organizations: [], understanding: { matched_topics: [], matched_geographies: [], likely_off_topic: true, suggestions: [{ type: 'nearby_topic', text: 'Buses' }], degraded: [] } }))
    renderPage()
    expect(await screen.findByText(/No one in the corpus has published near this/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Buses'))
    expect(routerPush).toHaveBeenCalledWith('/experts?q=Buses')
  })

  it('error: shows a retry that re-fetches', async () => {
    params.set('q', 'x')
    mockFetch.mockRejectedValueOnce(new Error('search service unavailable')).mockResolvedValueOnce(response())
    renderPage()
    expect(await screen.findByText(/search service unavailable/)).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })) })
    await waitFor(() => expect(screen.getByText('Xue, Lulu')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/__tests__/experts-page.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the page**

```tsx
// src/app/experts/page.tsx
'use client'

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Spinner } from '@chakra-ui/react'
import { AlertBanner, Button, Tag, Textarea } from '@worldresources/wri-design-systems'
import { FaArrowRightLong } from 'react-icons/fa6'
import Navbar from '@/app/components/results/Navbar'
import QuerySuggestions from '@/app/components/QuerySuggestions'
import { EmptyStateTopics } from '@/app/components/results/EmptyStateTopics'
import { ExpertsList } from '@/app/components/Experts/ExpertsList'
import { ExpertEvidence } from '@/app/components/Experts/ExpertEvidence'
import { OrganizationsStrip } from '@/app/components/Experts/OrganizationsStrip'
import { TopicChips } from '@/app/components/Experts/TopicChips'
import { TopicGraph } from '@/app/components/Experts/TopicGraph'
import { OFFICE_COLORS, OTHER_OFFICE_COLOR } from '@/app/components/Experts/officeColor'
import { fetchExperts } from '@/lib/experts-client'
import { peersOf } from '@/lib/experts/peers'
import type { ExpertsResponse } from '@/lib/experts/types'
import '../styles.css'

// encodeURIComponent, not URLSearchParams: the latter writes '+' for spaces,
// and the tests (and shared links) expect %20.
function buildUrl(q: string, person: string | null, exclude: string[]): string {
  const parts = [`q=${encodeURIComponent(q)}`]
  if (person) parts.push(`person=${encodeURIComponent(person)}`)
  if (exclude.length) parts.push(`exclude=${encodeURIComponent(exclude.join(','))}`)
  return `/experts?${parts.join('&')}`
}

const ExpertsPageContent = () => {
  const router = useRouter()
  const searchParams = useSearchParams()
  const q = searchParams?.get('q')?.trim() ?? ''
  const personParam = searchParams?.get('person') ?? null
  // Depend on the STRING, not the searchParams object: a new object per render
  // would re-fire the fetch effect forever.
  const excludeRaw = searchParams?.get('exclude') ?? ''
  const excludeParam = useMemo(() => excludeRaw.split(',').map((s) => s.trim()).filter(Boolean), [excludeRaw])

  const [draft, setDraft] = useState(q)
  const [excluded, setExcluded] = useState<string[]>(excludeParam)
  const [data, setData] = useState<ExpertsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(personParam)
  const loggedFor = useRef<string | null>(null)

  const run = useCallback(async (query: string, excluded: string[]) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetchExperts({ query, excluded_topics: excluded })
      setData(res)
    } catch (e: any) {
      setError(e?.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!q) { setData(null); return }
    setDraft(q)
    setExcluded(excludeParam)
    run(q, excludeParam)
  }, [q, excludeParam, run])

  useEffect(() => { setSelectedKey(personParam) }, [personParam])

  // Query log: once per (query, mode) after results render, fire-and-forget.
  useEffect(() => {
    if (!data || data.people.length === 0) return
    const stamp = `${data.query}|${data.mode}`
    if (loggedFor.current === stamp) return
    loggedFor.current = stamp
    fetch('/api/experts-mode-query-logs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: data.query, mode: data.mode, topTenPeople: JSON.stringify(data.people.slice(0, 10).map((p) => p.name)) }),
    }).catch(() => {})
  }, [data])

  const submit = () => {
    const v = draft.trim()
    if (!v) return
    router.push(buildUrl(v, null, []))
  }
  const select = (key: string) => {
    const next = selectedKey === key ? null : key
    setSelectedKey(next)
    router.push(buildUrl(q, next, excluded))
    // jsdom has no scrollIntoView; optional-call keeps tests honest.
    if (next) document.getElementById(`expert-row-${encodeURIComponent(next)}`)?.scrollIntoView?.({ block: 'nearest' })
  }
  // Chip removal is local state + a URL update + a re-fetch, so it works
  // without waiting for a navigation round-trip (spec §5.1 excluded_topics).
  const removeTopic = (label: string) => {
    const next = [...excluded, label]
    setExcluded(next)
    setSelectedKey(null)
    router.push(buildUrl(q, null, next))
    run(q, next)
  }

  const people = data?.people ?? []
  const matched = data?.understanding.matched_topics ?? []
  const totalWorks = useMemo(() => Object.keys(data?.docs ?? {}).length, [data])
  const activeKey = selectedKey ?? hoverKey
  const activePerson = activeKey ? people.find((p) => p.key === activeKey) ?? null : null
  const peers = useMemo(() => (activePerson ? peersOf(activePerson, people, matched, Math.max(totalWorks, 1)) : []), [activePerson, people, matched, totalWorks])
  const peerKeys = useMemo(() => new Set(peers.map((p) => p.key)), [peers])
  const selectedPerson = selectedKey ? people.find((p) => p.key === selectedKey) ?? null : null
  const offices = useMemo(() => new Set(people.map((p) => p.office)), [people])

  return (
    <>
      {/* React 19 hoists <meta> rendered anywhere into <head>. Unlisted page. */}
      <meta name='robots' content='noindex' />
      <Navbar query={q} />
      <main style={{ paddingTop: 64 }}>
        <AlertBanner title='For WRI staff use only' variant='warning'>
          <div style={{ textAlign: 'left' }}>
            Experts mode is an internal prototype. It ranks people by their published WRI work only; it has no contact details and no review or correction history.
          </div>
        </AlertBanner>

        <section className='gradient-background' style={{ padding: '22px 24px 18px', borderBottom: '1px solid #E6E2D6' }}>
          <div style={{ maxWidth: 1400, margin: '0 auto' }}>
            <p style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5E5B52', margin: '0 0 8px' }}>
              Who at WRI works on… <Tag label='Alpha' variant='info-grey' />
            </p>
            <div style={{ position: 'relative', maxWidth: 760 }}>
              <Textarea placeholder='Electric school buses' size='small' resize='none' value={draft} aria-label='Expertise query input'
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }} />
              <Button leftIcon={<FaArrowRightLong />} variant='primary' disabled={!draft.trim()} aria-label='Find people' type='button' onClick={submit}
                style={{ position: 'absolute', right: 12, bottom: 30 }} />
            </div>
            {!q && <QuerySuggestions mode='experts' onExampleClick={(s) => router.push(buildUrl(s, null, []))} />}
            {data && <TopicChips topics={matched} geographies={data.understanding.matched_geographies} onRemove={removeTopic} />}
            {data && people.length > 0 && (
              <p style={{ marginTop: 10, fontSize: 13, color: '#5E5B52' }}>
                <b>{data.total_people}</b> people across <b>{offices.size}</b> offices, on <b>{totalWorks}</b> documents that match. Showing the top {people.length}.
              </p>
            )}
          </div>
        </section>

        {q && error && (
          <div role='alert' style={{ maxWidth: 1400, margin: '18px auto', padding: '12px 24px', display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ fontSize: 14, color: '#a33' }}>{error}</span>
            <Button variant='secondary' size='small' onClick={() => run(q, excluded)}>Retry</Button>
          </div>
        )}

        {q && loading && !data && (
          <div style={{ minHeight: '40vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner /></div>
        )}

        {q && data && data.mode === 'topic_only' && people.length > 0 && (
          <p style={{ maxWidth: 1400, margin: '12px auto 0', padding: '8px 24px', fontSize: 14, color: '#8a6d3b', background: '#fcf8e3', border: '1px solid #faebcc', borderRadius: 4 }}>
            No direct matches for “{data.query}”. These people are closest by topic.
          </p>
        )}

        {q && data && !error && people.length === 0 && (
          <div style={{ padding: '32px', textAlign: 'center' }}>
            <p style={{ fontSize: 16, marginBottom: 12 }}>No one in the corpus has published near this.</p>
            <EmptyStateTopics query={data.query} topics={data.understanding.suggestions.filter((s) => s.type === 'nearby_topic').map((s) => s.text)}
              onPickTopic={(t) => router.push(buildUrl(t, null, []))} />
          </div>
        )}

        {q && data && people.length > 0 && (
          <div style={{ maxWidth: 1400, margin: '0 auto', padding: '18px 24px 48px', display: 'grid', gridTemplateColumns: 'minmax(380px, 460px) 1fr', gap: 20, alignItems: 'start', opacity: loading ? 0.6 : 1 }}>
            <section aria-labelledby='experts-list-h'>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px 10px', borderBottom: '1px solid #E6E2D6' }}>
                <h2 id='experts-list-h' style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>People closest to this question</h2>
                <span style={{ fontSize: 12, color: '#8A877E' }}>{data.mode === 'evidence' ? 'ranked by document evidence' : 'ranked by topic'}</span>
              </div>
              <ExpertsList people={people} mode={data.mode} selectedKey={selectedKey} peerKeys={peerKeys} onHover={setHoverKey} onSelect={select} />
              <OrganizationsStrip organizations={data.organizations} />
            </section>
            <section aria-labelledby='experts-graph-h'>
              <div style={{ background: 'white', border: '1px solid #E6E2D6', borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '10px 14px', borderBottom: '1px solid #E6E2D6', fontSize: 12, color: '#5E5B52' }}>
                  <div><strong id='experts-graph-h' style={{ color: '#1b1a17', fontWeight: 600 }}>Topic space</strong> · people sized by relevance, topics sized by match to the query</div>
                  <div aria-label='Office legend' style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                    {Object.entries(OFFICE_COLORS).map(([o, c]) => (
                      <span key={o} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 8, height: 8, borderRadius: '50%', background: c, display: 'inline-block' }} />{o}</span>
                    ))}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 8, height: 8, borderRadius: '50%', background: OTHER_OFFICE_COLOR, display: 'inline-block' }} />Other offices</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 10, height: 10, borderRadius: '50%', background: 'white', border: '2px solid #B8800A', display: 'inline-block' }} />Topic</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 8, height: 8, borderRadius: '50%', background: OTHER_OFFICE_COLOR, outline: '2px solid #1b1a17', outlineOffset: 2, display: 'inline-block' }} />Selected person</span>
                  </div>
                </div>
                <TopicGraph people={people} matched={matched} totalWorks={totalWorks} hoverKey={hoverKey} selectedKey={selectedKey} peerKeys={peerKeys} onHover={setHoverKey} onSelect={select} />
              </div>
              {selectedPerson && (
                <ExpertEvidence person={selectedPerson} docs={data.docs} peers={peers} mode={data.mode} matched={matched} onSelectPeer={select} onClose={() => select(selectedPerson.key)} />
              )}
            </section>
          </div>
        )}
      </main>
    </>
  )
}

const ExpertsPage = () => (
  <Suspense fallback={<div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner /></div>}>
    <ExpertsPageContent />
  </Suspense>
)

export default ExpertsPage
```

Notes for the implementer:
- `totalWorks` for the specificity calculation is approximated by the number of docs in the payload. Replace with a `total_works` field if the ranking's `N` is ever exposed; the peer threshold is a prototype default either way (spec §4.5).
- The bare `<meta>` relies on React 19 hoisting; if lint or the build rejects it, move `robots: 'noindex'` into a `src/app/experts/layout.tsx` exporting `metadata` (server component) that wraps `children`.
- Evidence titles link to the publication URL (`DocResult.url`). The spec's earlier mention of `DocumentPreviewModal` is superseded: that modal needs a cite-mode `RowData`; reuse is a follow-up.
- The two-column grid collapses under 980px via the existing global CSS approach: add to `Experts.css` `@media (max-width: 980px) { .experts-bench { grid-template-columns: 1fr !important; } }` and put `className='experts-bench'` on the grid div.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/__tests__/experts-page.test.tsx`
Expected: PASS. If the bare `<meta>` warns in jsdom, apply the layout.tsx note above and re-run.

- [ ] **Step 5: Run the page in the browser once**

Run (dev, needs local stack per `docs/runbooks/local-testing.md`): `npm run dev`
Open `http://localhost:3000/experts?q=electric%20buses`, hover rows and nodes, select a person, remove a chip, and confirm the URL updates. Compare against the mockup.

- [ ] **Step 6: Commit**

```bash
git add src/app/experts/page.tsx src/app/components/Experts/Experts.css src/__tests__/experts-page.test.tsx
git commit -m "feat(experts): unlisted /experts page with list, graph, evidence, and states"
```

---

### Task 13: Labeled query set skeleton and final review

**Files:**
- Create: `evaluation/experts/README.md`
- Create: `evaluation/experts/queries.json`
- Create: `evaluation/experts/validate.ts`
- Test: `evaluation/__tests__/experts-queries.test.ts`

**Interfaces:**
- Produces: `evaluation/experts/queries.json` schema `{ version: 1, queries: [{ id, query, expected_top3: string[] (author keys), notes }] }`; `npx tsx evaluation/experts/validate.ts` exits non-zero on schema errors.

- [ ] **Step 1: Write the failing test**

```ts
// evaluation/__tests__/experts-queries.test.ts
/** @jest-environment node */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateQueries } from '../experts/validate'

describe('evaluation/experts/queries.json', () => {
  it('parses and validates', () => {
    const raw = JSON.parse(readFileSync(join(__dirname, '..', 'experts', 'queries.json'), 'utf8'))
    expect(validateQueries(raw)).toEqual([])
    expect(raw.queries.length).toBeGreaterThanOrEqual(10)
  })
  it('rejects a query without a key-shaped expectation', () => {
    expect(validateQueries({ version: 1, queries: [{ id: 'q1', query: 'x', expected_top3: ['Xue Lulu'], notes: '' }] })).toEqual([
      'q1: expected_top3[0] "Xue Lulu" is not an author key (family, given)',
    ])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest evaluation/__tests__/experts-queries.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the files**

```ts
// evaluation/experts/validate.ts
// Schema check for the experts labeled set. Keys are author keys from
// src/lib/experts/authorKey.ts: "family, given" lowercase.
export interface LabeledQuery { id: string; query: string; expected_top3: string[]; notes: string }
export interface LabeledSet { version: number; queries: LabeledQuery[] }

const KEY_RE = /^[^,]+, [^,]+$|^[^,\s]+$/

export function validateQueries(raw: any): string[] {
  const errors: string[] = []
  if (raw?.version !== 1) errors.push('version must be 1')
  if (!Array.isArray(raw?.queries)) return [...errors, 'queries must be an array']
  const ids = new Set<string>()
  for (const q of raw.queries) {
    if (!q.id || ids.has(q.id)) errors.push(`duplicate or missing id: ${q.id}`)
    ids.add(q.id)
    if (typeof q.query !== 'string' || !q.query.trim()) errors.push(`${q.id}: query is required`)
    if (!Array.isArray(q.expected_top3)) { errors.push(`${q.id}: expected_top3 must be an array`); continue }
    q.expected_top3.forEach((k: unknown, i: number) => {
      if (typeof k !== 'string' || !KEY_RE.test(k) || k !== k.toLowerCase()) errors.push(`${q.id}: expected_top3[${i}] "${k}" is not an author key (family, given)`)
    })
  }
  return errors
}

if (require.main === module) {
  const fs = require('node:fs')
  const path = require('node:path')
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'queries.json'), 'utf8'))
  const errs = validateQueries(raw)
  if (errs.length) { console.error(errs.join('\n')); process.exit(1) }
  console.log(`ok: ${raw.queries.length} queries`)
}
```

`evaluation/experts/queries.json` — ten queries drawn from the Cities corpus themes, with `expected_top3` **empty** until a Cities program owner labels them (an empty array is valid; the README says who fills it and how):

```json
{
  "version": 1,
  "queries": [
    { "id": "q01", "query": "electric school buses", "expected_top3": [], "notes": "US-heavy; School Buses df 10" },
    { "id": "q02", "query": "zero-emission freight trucks in China", "expected_top3": [], "notes": "" },
    { "id": "q03", "query": "bus rapid transit financing", "expected_top3": [], "notes": "" },
    { "id": "q04", "query": "compact urban growth in India", "expected_top3": [], "notes": "" },
    { "id": "q05", "query": "land value capture", "expected_top3": [], "notes": "" },
    { "id": "q06", "query": "nature-based solutions in Brazilian cities", "expected_top3": [], "notes": "" },
    { "id": "q07", "query": "informal settlements and climate resilience", "expected_top3": [], "notes": "" },
    { "id": "q08", "query": "pedestrian road safety", "expected_top3": [], "notes": "" },
    { "id": "q09", "query": "public charging infrastructure", "expected_top3": [], "notes": "" },
    { "id": "q10", "query": "cities in NDCs", "expected_top3": [], "notes": "climate governance" }
  ]
}
```

`evaluation/experts/README.md`:

```markdown
# Experts mode labeled set

The measurement instrument for `/experts` ranking (spec §10). Until a Cities
program owner fills `expected_top3` with author keys (`family, given`,
lowercase — see `src/lib/experts/authorKey.ts`), every weight in
`src/lib/experts/rank.ts` and `peers.ts` is a prototype default and no
threshold may be called tuned.

- Validate: `npx tsx evaluation/experts/validate.ts`
- Small-n (10–20 queries) justifies direction only, never thresholds.
- Score by hand for now: run each query on QA, record the top 3 keys, compare.
  A scoring script is a follow-up once at least 10 queries are labeled.
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest evaluation/__tests__/experts-queries.test.ts`
Expected: PASS.
Run: `npx tsx evaluation/experts/validate.ts`
Expected: `ok: 10 queries`.

- [ ] **Step 5: Final cross-cutting checks**

Run: `npm test`
Expected: all suites pass (db suites skip without `DATABASE_URL`).
Run: `npm run lint`
Expected: clean.
Run: `npm run format:check`
Expected: clean (run `npm run format` and re-stage if not).
Run: `cd search-service && ./venv/bin/python -m pytest tests/ -v`
Expected: pass.
Run: `npx next build --webpack`
Expected: builds; `/experts` listed as a route.

Then review the whole diff once against the spec and mockup: every state in spec §7 reachable; office colors and selected-person treatment match §8; counts over works; no `/query` contract change (`git diff qa -- search-service/app/main.py` shows only the additive endpoint and models).

- [ ] **Step 6: Commit**

```bash
git add evaluation/experts evaluation/__tests__/experts-queries.test.ts
git commit -m "chore(experts): labeled query set skeleton and validator"
```

Open the PR against `qa` with the first body line `Refs #411` (the author-format issue this feature works around), link the spec and mockup, and run `gh pr checks` per the repo's issue-link rule.
