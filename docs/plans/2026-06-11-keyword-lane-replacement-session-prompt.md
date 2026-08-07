# Session prompt: replace the in-memory BM25 keyword lane (evidence-gated)

> Copy everything below into a fresh Claude Code session in this repo.

---

Investigate replacing the search-service's **in-memory BM25 keyword lane** with a
Postgres-resident alternative, and implement it **only if evidence shows retrieval parity or
better**. This is a design-first, eval-gated task: produce a design note with measured evidence
and get my sign-off on the chosen option **before** writing the implementation plan.

## Why (the problem being solved)

The hybrid retriever has two lanes: dense (pgvector, filtered per-query on
`status='searchable'`) and BM25 (built **in memory** at service boot and on `POST /reindex`
from searchable chunks). The in-memory lane is the system's single biggest source of
accidental complexity:

- Lifecycle changes (admin promote/withdraw, worker publish) need a best-effort `/reindex`
  POST; until it succeeds, keyword results are stale (withdrawn docs still surface; promoted
  docs missing).
- `/reindex` is synchronous and takes **~9 minutes** on the current corpus (169 docs / 30,526
  chunks, measured locally 2026-06-10), far beyond the app tier's 120s timeout — so the admin
  UI effectively always shows the staleness warning. A concurrency lock (409 on overlap) was
  added, but state is still cleared during rebuild.
- Two services share this choreography: `src/lib/search-reindex.ts` + the admin status route
  (app tier) and `search-service/worker/stages/publish.py` (worker).

A Postgres-resident keyword lane makes withdraw/promote **instantly consistent** (one UPDATE,
no rebuild), deletes the choreography, and makes the search-service stateless for keyword
retrieval.

## Hard constraints

1. **`/query` request/response contract is untouchable** — `QueryRequest`/`QueryResponse` in
   `search-service/app/main.py`. Internals may change; the contract may not.
2. **Evidence before adoption.** Capture a FRESH baseline with the current code on the current
   corpus before changing anything (don't trust old numbers). The decision gate is: candidate
   ≥ baseline on the evals, no material latency regression.
3. **The eval harness is English-only, but the corpus is multilingual** (en, es, zh, pt, id;
   zh chunks are stored as Simplified Chinese — OpenCC t2s at ingest). Any candidate must not
   silently regress non-English keyword matching. Since no non-English eval exists, build a
   small **non-English smoke set** (~10–15 hand-checked queries in zh/es/pt with known target
   docs, derived from `documents` metadata/titles) and compare lanes before/after. This is a
   smoke test, not a golden set — say so honestly in the design note.
4. **RDS constraint:** the production Postgres is RDS (provisioned outside this repo's
   terraform). Extension allowlist matters — `pgvector` and `pg_trgm` are available on RDS;
   CJK segmenters (`zhparser`, `pg_jieja`/`pg_jieba`) and ParadeDB `pg_search` are **not**.
   Verify current availability rather than assuming.
5. **Reversibility:** implement behind a flag (e.g. `KEYWORD_BACKEND=memory|<new>` in
   `search-service/app/config.py`, mirroring the existing `RETRIEVAL_BACKEND` pattern) so the
   old lane remains one env var away.
6. **Git:** local `qa` branch is ~66 commits ahead of origin and **must not be pushed**. Work
   on a feature branch off `qa`; merge back `--no-ff` locally when done.

## Candidate options to evaluate (research all, recommend one)

a) **Postgres FTS** (`tsvector` + GIN): per-language `regconfig` for en/es/pt/id;
   the open problem is zh — default parsers don't segment CJK and RDS lacks zhparser.
   Possible zh fallback: bigram tokenization into tsvector, or option (c) for zh only.
b) **BM25-as-sparse-vector:** `document_chunks.sparse sparsevec` **already exists in the
   schema and is empty (0/30,526 populated)** — Phase 0 anticipated this lane. Store
   BM25/SPLADE-style weighted term vectors per chunk, query via sparse inner product. Pure
   pgvector (RDS-safe), language-agnostic tokenization stays in Python (the current BM25
   tokenizer can be reused, keeping zh behavior identical to today). Requires backfill +
   worker embed-stage change.
c) **pg_trgm** similarity as the keyword lane (or as the CJK-only fallback under option a).
d) **Do nothing structural:** keep in-memory BM25, make `/reindex` incremental or
   build-then-swap + debounced. Include this as the baseline option so the comparison is
   honest about implementation cost vs. payoff.

A hybrid (a + b/c for zh) is acceptable if the evidence supports it. Mind RRF fusion: scores
feed reciprocal-rank fusion, so rank order matters more than score scale — but verify fusion
weights still behave (retrieval tuning itself is otherwise out of scope).

## Evidence plan (the gate)

1. Baseline: search-service running in postgres mode → `npm run eval:cite` and
   `npm run eval:answer-retrieval`. Record P/R/F1 + per-query results. (Reference: Phase 1
   baseline was eval:cite P .2442 / R .8450 / F1 .3679, 8/11 — re-measure anyway.)
2. Build the non-English smoke set (constraint 3) and record baseline lane behavior.
3. Implement the candidate behind the flag; backfill local corpus; rerun 1–2; compare.
4. Latency: p50/p95 of `/query` before/after (the eval runs give you timings; otherwise time a
   fixed query set).
5. Consistency: withdraw a doc → keyword lane excludes it immediately, no reindex; promote →
   included immediately. (This is the whole point — demonstrate it.)

## If adopted, the simplification payoff (remove or no-op these)

- `src/lib/search-reindex.ts` + the `reindex` field/notices in
  `src/app/api/admin/documents/[id]/status/route.ts`, `src/app/admin/review/page.tsx`,
  `src/app/admin/documents/[id]/page.tsx`
- the reindex POST in `search-service/worker/stages/publish.py`
- boot-time BM25 build + `/reindex` rebuild path in `search-service/app/main.py`
  (`/reindex` endpoint itself: keep returning success or deprecate — decide in design,
  it's consumed nowhere else after the above removals)
- docs: `docs/document-management.md` §4 (the BM25 gotcha) and §11 lifecycle notes

## Context pointers (read these first)

- `docs/document-management.md` — §4 (BM25 gotcha, as-built), §10 (worker), §11 (admin UI)
- `docs/research/2026-06-10-multilingual-retrieval-design-research.md` — prior multilingual
  options research
- `docs/plans/2026-06-09-askwri-document-management-design.md` — system design
- `docs/plans/2026-06-10-phase2-admin-ui-implementation-plan.md` — Task 20 deviation notes
  (measured 9-min reindex)
- Code: `search-service/app/main.py` (service_state, load_from_postgres, /reindex, /query),
  `search-service/app/pg_store.py` (dense lane), `search-service/app/config.py` (settings),
  `search-service/worker/stages/embed.py` (chunk writes — where sparse backfill would live),
  migration `src/db/migrations/1781280000000-Migration.ts` (schema incl. the empty
  `sparse sparsevec` column)
- Evals: `evaluation/` (golden sets + runners), commands `npm run eval:cite`,
  `npm run eval:answer-retrieval` (search-service must be running)

## Local environment facts (verified 2026-06-11 — don't re-derive)

- DB: docker `askwri-pg`, db `qa`, 169 docs / 30,526 chunks; `.env` points at it
  (`DATABASE_URL=postgresql://askwri:password@localhost:5432/qa`); `RETRIEVAL_BACKEND=postgres`
  is set in `.env`.
- Run the search-service with `cd search-service && ./venv/bin/python -m app.main`
  (NOT `npm run search-service` — the venv has no `pip` shim). Boot takes ~3 min.
- Python tests: `npm run test:python` (86 pass; DB-gated suites create scratch databases).
- Next build: use `npx next build --webpack` (Turbopack panics on the venv symlink locally).
- JS tests: `npm test` (133) and `npm run test:db` (33).
- A new migration `1781300000000` exists on qa (open-job unique index + FK cascade) — already
  applied to the local docker db.

## Process

1. Read the context pointers; run the baseline evals.
2. Write a design note (`docs/plans/2026-06-11-keyword-lane-*.md`) comparing the options with
   the measured evidence and a recommendation. **Stop and get my sign-off.**
3. Then write the implementation plan (superpowers:writing-plans) and execute it
   (superpowers:subagent-driven-development), eval gate before merge.

Working rules: one command per Bash call (no `&&`/`;`/pipes/env-prefixes); never push qa or
feature branches; commit per task; token-efficiency (cheap models for mechanical subagent
work, judgment in the main loop); narrate file paths as you work.
