# Code Review Handoff — feature/query-expansion (P0+P1 query understanding)

**To:** separate review session
**From:** controller session that implemented the branch
**Date:** 2026-08-19
**Branch:** `feature/query-expansion` (worktree `.claude/worktrees/feature-query-expansion`)
**Base:** `qa` (merge-base `566a0ce`)
**Head:** `e5db483` (18 commits, 38 files, +6795/−19)
**Flag:** `QUERY_UNDERSTANDING_ENABLED` — OFF by default; all new query-path code behind `understanding is not None`. **Do not enable it during review.**

---

## What this branch is

P0 + P1 of the query-expansion design: a deterministic query-understanding
sidecar (facet parsing, trigram did-you-mean, tag-embedding topic sensing) that
produces one schema-validated `QueryUnderstanding` per query, wired into
`/query` behind a dark flag, with a Next.js interpretation-line + removable-chip
UX. Flag-off is byte-identical to the pre-feature pipeline (measured in the gate
doc). P2 (multi-lane RRF) and P3 (LLM sidecar) are explicitly out of scope.

**Read these first (in order):**
1. `docs/plans/2026-08-19-query-expansion-design.md` — the design spec (§2
   invariants, §4 architecture, §5 failure posture, §7 gates govern everything)
2. `docs/plans/2026-08-19-query-expansion-p0-p1-implementation.md` — the
   14-task plan (argues from the spec; the "Global Constraints" section is
   binding)
3. `docs/plans/2026-08-19-query-expansion-p1-gate-results.md` — the gate doc
   (Step 2 PASS: flag-off byte-identical; Step 3a BLOCKED on qa `pg_trgm` ops
   prereq; local flag-on evidence + the q10 nuance)
4. `.superpowers/sdd/2026-08-19-query-expansion-p0-p1-implementation/progress.md`
   — the SDD ledger (per-task status, parked findings, final cross-cut review)

## The 18 commits (merge-base → HEAD)

```
e5db483 docs(understanding): P1 gate results
eb1a257 style: prettier formatting for query-understanding UI + migration
161963e feat(ui): did-you-mean auto-switch + empty-state nearby topics
4fe7904 feat(ui): interpretation line with removable facet chips + did-you-mean
7b67df3 feat(ui): project query_understanding through the llamaindex route + client
3be1cd1 feat(understanding): wire deterministic tier into /query behind dark flag
7bf1b58 feat(understanding): single pre-rerank facet filter point
b998e84 feat(understanding): hydrate language/article_type/year_int into documents_metadata
332afab feat(understanding): tag-embedding topic sensing (suggestions only)
7df4ae1 feat(understanding): trigram did-you-mean suggester with trap fixtures
205c058 feat(understanding): search_vocab table + offline vocab builder
49a6c05 feat(understanding): deterministic year/language facet parsers + labeled fixture set
6f9fff5 feat(understanding): QueryUnderstanding schema + dark flag
02c827c chore(eval): P0 baseline capture for query-understanding gates
f2a79ae docs(understanding): drop non-EN smoke gate; gate on cite + answer-retrieval only
b7d1917 feat(retrieval): per-lane rank attribution in debug (P0 instrument)
0822bcd docs(understanding): P0+P1 implementation plan (14 tasks, TDD, dark-flagged)  [pre-feature]
38dc705 docs(retrieval): query expansion & understanding design spec            [pre-feature]
```

The bottom two (`0822bcd`, `38dc705`) are pre-feature docs; `f2a79ae` and
`02c827c` are coordination commits (plan reconciliation + baseline capture).
The 13 `feat`/`style`/`docs` commits above those are the implementation.

## Review coverage that already happened (and what didn't)

- **Tasks 1-3: full SDD review** (fresh implementer → review package → task
  reviewer subagent → ledger). All clean. Task 1 had 2 plan-mandated Minor
  nits (unused test imports, dup-node-id rank edge — both verbatim from the
  brief). Task 3 had a ⚠️ deferred to Task 10 (understanding_active wiring) —
  verified clean in the final cross-cut review.
- **Tasks 4-14: NO independent per-task review.** The `pi-subagents` package
  updated mid-session and shipped a `gpt-pro` builtin with an invalid
  `runner.type`, which broke all subagent dispatch. The operator chose to have
  me implement Tasks 4-14 directly in the controller session with the same TDD
  discipline (failing test → verify → implement → verify → run leak detectors).
  **Self-review + final cross-cutting review only.** This is the gap the
  separate-session review fills.

## Risk areas to focus on

These are the seams where per-task review would most likely have caught
something, ordered by blast radius.

### 1. Task 10 wiring in `search-service/app/main.py` (highest risk)

This is the integration task. Everything must sit behind `understanding is not
None`. The leak detectors (`test_diagnostic_parity.py`, `test_query_nonblocking.py`)
pass, and Step 2 of the gate proved flag-off is byte-identical on qa (cite R
Δ=0.0000, answer all aggregates Δ=0.0000) — but a human review should re-verify:

- **L1015 `if understanding_active(settings, request):`** — is the guard
  correct, and is `build_understanding` (L1018) the only thing inside it that
  mutates state outside the `understanding` object?
- **L1076 `if understanding is not None:` (topic sensing)** — runs after stage1
  retrieve to warm the embed cache. Does `attach_topic_suggestions` ever throw
  into the response path? (It's failure-soft by design — verify.)
- **L1102 `if understanding is not None:` (facet filter)** — this is THE single
  pre-rerank application point. Does it correctly no-op when there are no hard
  facets (returns the same list object)? Does `legacy_request_facets` correctly
  convert `min_year`/`max_year`/`required_program`/`excluded_keywords`?
- **L1156 `if understanding is None and ...` (Stage 2.5 guard)** — the legacy
  post-rerank filter is skipped when the new pre-rerank point ran. Is the
  condition exactly right? (Off-by-one here = double-filter or no-filter.)
- **L1363, L1390-1392 (response/debug)** — `understanding.model_dump()` only
  when non-None; debug entries nullable. Flag-off → all None.
- **EMF (`_emit_query_emf`)** — the `counts` dict + `understanding_ms` metric +
  the `if not metrics and not counts: return` guard + the
  `**metrics, **counts` spread. Did the restructure break the all-Milliseconds
  invariant for the existing metrics?

### 2. Task 12-13 UI state threading in `src/app/results/page.tsx`

- `userFacets`/`understanding`/`autoSwitchedFrom` state; cache key
  `` `cite:${q}:${JSON.stringify(userFacets ?? 'auto')}` ``; reset on `q`
  change; `runAsTyped` (expansion:false); auto-switch decidable rule
  (`docs.length < 3` + spelling suggestion + `autoSwitchedFrom === null`).
- Is the auto-switch loop-proof? (One per user-initiated search; `expansion:
  false` suppresses re-suggest.) Is there any path where a removed chip serves
  the auto-mode cached result?
- The reverse-link renders above `CitePanel` in a fragment — is the JSX
  well-formed and the prop pass-through complete?

### 3. The q10 gate nuance (gate doc §3c)

Golden query `q10_urban_finance_since_2020` carries `since 2020`, which the
parser correctly extracts to `year_min=2020` (hard), correctly filtering
pre-2020 docs from its expected set. The local flag-on cite recall dropped
0.060 because of this. **This is design-correct, not a bug** — but the review
should confirm that judgment. The gate rule "macro recall may not fall" needs
the nuance that q10 is a faceted query. Options: (a) accept the drop as
design-correct; (b) exclude faceted golden queries from the flag-on cite
comparison; (c) remove q10 from the golden set for flag-on runs. This is a
plan/spec edit, not a code change — but the reviewer should weigh in.

### 4. The `bogata` trap-label fix (Task 6, operator decision A)

The fixture's `bogata`→`bogota` case was changed to `expect: null` (trap) at
threshold 0.45 (trigram sim 0.40, below threshold). The alternative was to
lower the threshold to 0.40. The reviewer should sanity-check that 0.45 is
the right conservative threshold and that `bogata` is genuinely a trap, not a
misspelling we should be correcting. See
`search-service/tests/fixtures/didyoumean_queries.json` + the test at
`search-service/tests/test_spell_suggest.py`.

### 5. Fixture-label integrity (operator binding rule #2)

`search-service/tests/fixtures/facet_queries.json` (30 queries) and
`didyoumean_queries.json` (9 cases) are load-bearing derivation artifacts. If
the review finds a fixture case that seems mislabeled, **stop and ask the
operator** — do not change the fixture unilaterally. The `bogata` fix was an
operator decision.

## What NOT to review (out of scope)

- P2: multi-lane weighted RRF, alias lane, retiring `DOMAIN_EXPANSIONS`
  OR-stuffing. Not on this branch.
- P3: LLM sidecar, intent classification, catalog mode, disambiguation
  readings. Not on this branch.
- Retrieval tuning (RRF weights, rerankers, thresholds/tiers), answer synthesis,
  eval internals. Separate workstreams.
- The non-English smoke / cross-lingual EN probe. **Removed from the gate per
  operator decision (D)** — non-English *queries* are out of scope (design §9);
  multilingual *document* retrieval is protected via the cite golden set.

## Environment notes for the reviewer

- The worktree has **no `search-service/venv`** — use the main repo's:
  `cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest <path> -v`
  (deps from the venv, `app.*` imports from the worktree cwd — verified working).
- `search-service/.env.local` is gitignored; if it's missing, copy from the
  main repo: `cp /Users/gutelius/dev/askwrimvp/search-service/.env.local search-service/.env.local`.
  It has local MinIO AWS creds — strip those if you boot the service against
  real AWS/Bedrock.
- Local docker stack (`askwri-pg`) is up; `search_vocab` is built (713 terms);
  `pg_trgm` is installed locally. qa RDS does NOT have `pg_trgm` (gate blocker).
- JS tests: `npx jest` (384 passed / 232 skipped baseline). Lint: `npm run lint`.
  Format: `npm run format:check`.
- Leak detectors (run these after any python change):
  `cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_diagnostic_parity.py tests/test_query_nonblocking.py -v`

## The binding rules (from the operator — govern the review too)

1. Flag-off is byte-identical. Any new query-path code not behind
   `understanding is not None` is a defect.
2. Fixture labels are load-bearing. A trap case that fails = fix the pattern,
   not the fixture. If a label looks wrong, **stop and ask the operator**.
3. No new Python deps; `requirements.txt` untouched. `pg_trgm` is a Postgres
   extension, not a Python dep.
4. The `%%` in Task 6's SQL is the psycopg-escaped trigram operator, not a
   typo.
5. Scope discipline: no P2/P3 code. No extra features, no speculative refactors.
6. The flag stays OFF everywhere; activation is a separate gated ops step.
7. Do not push or open a PR. Return findings to the operator.

## Suggested review output

A findings list grouped by task, each with severity (Critical / Important /
Minor), file:line, and a one-line fix suggestion. Flag any finding that
conflicts with plan/spec text as "plan-mandated" — the operator decides those.
End with an overall verdict: merge-ready / needs fixes / blocked.
