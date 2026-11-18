# Route model sweep — design

**Date:** 2026-11-12
**Status:** approved 2026-11-12
**Scope:** a tool that lets a human compare two models on the four routes that have
no evaluation today, before changing the model those routes run.

## Intent

The OpenAI models behind four routes are due for replacement, and there is no way
to see what a replacement does. Today each of those routes pins its model in a
module-scope const read at import time, so comparing two models means editing a
GitHub secret and redeploying QA, or booting a dev server per model — and then
reading two UIs and hoping to remember the first one.

The purpose of this tool is **informed consent for a model swap**: run the same
real inputs through both models, put the outputs side by side, and let a person
read them once and decide. It is not a scoring harness and it produces no
threshold.

Why now: the models currently live are `gpt-5.4-mini` (answer synthesis,
translate) and `gpt-5.4-nano` (why, relates, alignment). `docs/model-inventory-and-migration.md`
sequenced a move to the 5.6 line but predates anyone actually having to perform
one on these routes. WRI guidance on the target models is pending; this tool is
what gets used once it arrives.

## What exists today

| Route | Input | Output | Model today |
|---|---|---|---|
| `POST /api/batch-why` | `{query, mode, passages: [{docTitle, snippet}]}` | `{ok, explanations[]}` | `gpt-5.4-nano` |
| `POST /api/batch-relates` | `{query, docs: [{title, authors, year, snippet}]}` | `{results: [{relates, …}]}` | `gpt-5.4-nano` |
| `POST /api/alignment` | `{query, resultsSummary}` | `{ok, assessment: {insights, alignment}}` | `gpt-5.4-nano` |
| `POST /api/translate` | `{text}` | `{ok, translation}` | `gpt-5.4-mini` (via `OPENAI_MODEL`) |

All four are **unauthenticated** — no session check, only a Bearer to OpenAI. They
are reachable on QA's public host, so nothing here needs a local stack, database,
or corpus build.

Their payloads are not independent: the UI builds all four from one retrieval
result. `buildAlignmentSummary` and `titleFrom` in `src/app/utils/utils.tsx` are
the shipped builders; `src/app/results/page.tsx` and
`src/app/components/AnswerMode/SupportingCitations.tsx` show the projections in use.

`evaluation/answer/` already solves the *harder* version of this problem for
answer synthesis — capture → judge → score → compare, with a `body.model` knob and
recorded provenance. Its fixtures are answer-shaped and its metrics are judged, so
neither transfers. Its **conventions** do.

## Goals

1. Run one real input set through two models on all four routes, in one command.
2. Produce a side-by-side a person can read in one sitting (default: ~10 cases).
3. Record enough provenance that a reader can tell which model, which input, and
   which code produced any given output — and never compare a model against itself
   by accident.
4. Catch the mechanical failures automatically, so the human reads for quality only.

## Non-goals

- No LLM judge, no scoring, no pass/fail threshold, no CI gate.
- No new ground-truth fixtures. Inputs come from the pinned `evaluation/eval-review`
  submodule, so provenance traces to reviewed data.
- Not the ingestion worker's summaries/tagging (Python, different call path) and not
  answer synthesis (it has a harness). Separate work.
- No `base_url` / cross-provider candidates. Same provider, model name only. Add it
  if a candidate ever lives elsewhere.
- No production use. The override is a QA instrument.

## Anti-goals

- A sweep that reports two models but ran one — the failure that makes every other
  number worthless.
- A tool heavy enough that nobody runs it before a swap. If it takes longer to set
  up than to read the outputs, it will not be used.
- A readout that needs scrolling through 400 lines to find the one changed paragraph.

## Approaches considered

**A. Freeze the retrieval, then sweep. *(chosen)***
One cite query per case through the gateway, saved to an artifact. Then project that
frozen result into each route's real payload and post it at each model. Reruns are
deterministic and cost only the route calls; the input is what a real query returns.
Mirrors the answer harness's capture/judge split.

**B. Hand-authored payload fixtures.**
A checked-in JSON of what each route should receive. Simplest to run, but four payload
shapes per case invented by hand, aging with every corpus change, and no longer
reflecting what the UI sends.

**C. Drive the real UI (Playwright).**
Exercises the shipped path end to end, including the components that build payloads.
Rejected: per-page plumbing, flaky, and slow — and the payload builders are importable
functions, so C buys nothing that A does not get by importing them.

A was chosen because the four routes consume different projections of a single
retrieval result: freezing that result once is both realistic and deterministic, which
B cannot be and C overpays for.

## Design

### 0. The problem this must beat: silent fallbacks

Three of these four routes answer HTTP 200, `ok: true`, with correct array lengths and
non-empty strings **without the named model having produced anything**:

- `batch-relates` upstream error → canned `'Relevant supporting evidence.'` per doc
  (`route.ts:141`), signalled only by `debug.status` / `debug.upstream`.
- `batch-why` parse failure → `fallback: true` (`:267`); and the `isEnglishText`
  substitution at `:228-231` replaces mirrored output with a canned sentence and sets
  **no flag at all**.
- `alignment` → every failure path is `ok:true` plus `debug.fallback` (`:593`, `:619`),
  and `sanitizeAssessment` can substitute the canned insight while still reporting
  `fallback: false` (`:216`).
- Zero-doc retrieval makes `batch-relates` return `{ok:true, results: []}` (`:73`) with
  no model call at all — a clean-looking row for both models.

Every mechanical check in §4 passes on such a run. That is precisely the anti-goal, so
PR 1 carries a **machine-readable "the model produced this" signal** on all four routes:
a single `provenance` block (`model`, `produced: true|false`, `fallback_reason`) on every
return path, including the sanitizer's. A row where `produced` is false is not evidence
and the readout says so plainly.

Deliberately *not* adding an un-sanitized output path. The sanitizer fires most on the
non-English cases, which is exactly where a reader wants to see the model's real
behaviour — but exposing raw output would test a path no user sees. Showing that a
fallback fired, plus the reason, is the honest middle: the reader learns the row is not
evidence without the tool measuring a different route.

### 1. The model-override knob (enables the sweep)

A shared helper in `src/lib/`, used by all four routes, replacing their module-scope
consts:

```
resolveRouteModel(req, body, fallback)
  -> { ok: true; model: string; isGpt5: boolean } | { ok: false; error: string }
```

- If `body.model` is absent → `fallback` (today's behaviour, unchanged).
- If present and `EVAL_MODEL_OVERRIDE_TOKEN` is set and the request's `x-eval-token`
  header matches → that model.
- If present and the token is unset or wrong → **400**. Never silently ignore: a
  sweep that thinks it ran two models must not run one twice.

`EVAL_MODEL_OVERRIDE_TOKEN` goes in `qa.tfvars` `app_environment_variables` and is
absent from `production.tfvars`, so production refuses overrides structurally. It is
a plain var, not a secret: its only power is choosing a model on QA, and anyone who
can read task-definition env already holds the shared OpenAI key itself (see
"Known limits").

Each route echoes the model it actually used in its JSON response, inside the
`provenance` block of §0, so the artifact proves what ran rather than trusting the
request. This is the same property `/api/answer` gets from `debug.knobs.model`.

**The model-derived parameters must follow the resolved model, not the module const.**
Each route branches on the model to pick token caps, temperature, and timeout ladders
(`batch-why:18-70`, `batch-relates:20-22`, `alignment:31-57`, `translate:19-24`). If
that branching keeps reading the const, a candidate without a `gpt-5` prefix gets
`max_tokens` + `temperature`, the provider 400s, and the route returns canned text —
§0's failure mode on every call.

### 2. Stage one — freeze the retrieval

For each selected case: one cite query at the deployed gateway (`/api/llamaindex`,
same target convention as `run-evalset.ts`, `EVAL_TARGET` defaulting to
`https://qa.askwri-app.org`), with the case's `question` as the query. Save the full
response. This artifact is the input for everything downstream and is reusable across
model pairs.

Request: `{query, mode: 'cite', max_results: 40}` — 40, not the gateway preset's 25,
because 40 is what the UI sends (`src/lib/llamaindex-client.ts`) and the sweep exists to
mirror what users get. Doc count is the input size for three of the four payloads and it
selects the truncation regime (`batch-why` drops to 200 chars/snippet past 2,000 total;
`batch-relates` slices 500), so it is recorded in the header and overridable.

Case selection: default to the named set `evalset_answer_02`, first `--limit` cases
(default 10), with `--evalset` and `--ids` to choose otherwise. Note there is **no
`headline`/`expert_approved` tier in the pinned submodule** — `review_status` appears on
zero cases at `1dcbeab` — so filtering on a review tier would match nothing. Prefer
`expert_approved` only if a future pin introduces it, and say so in the header when the
set has none. Do not bump the submodule pin as part of this work; the pin *is* the
provenance anchor.

Every case in the submodule is non-English (`evalset_answer_02`: 10 zh / 6 es), so
translate is exercised on genuinely foreign text by construction rather than by filter.
The consequence to state in the readout: there is no English control case, so a
regression that only shows on English input would not appear here.

### 3. Stage two — sweep the routes

For each frozen case, build each payload by **importing the shipped builders** —
`buildAlignmentSummary`, `titleFrom`, `authorsFrom`, `yearFrom` from
`src/app/utils/utils.tsx` — so the sweep cannot drift from what the UI sends. Fetch
`/api/catalog` from the target once and pass the index into them, matching
`src/app/results/page.tsx:419`; without it the alignment payload silently loses
`Languages among the results` on every case. Scripts run from the repo root: `tsx`
resolves `@/` from the cwd's tsconfig.

Then `routes × models` calls against the target, with a per-call timeout flag
(default generous — candidate models on this stack have historically been several
times slower than the incumbent, which is exactly how a swap times out in production).
The ceiling is 300 s regardless: that is the ALB `idle_timeout`
(`terraform/infrastructure/alb.tf:12`), and a longer flag value would produce a client
timeout indistinguishable from a dead model.

`--limit` defaults low on purpose: every run costs money on the shared key.

### 4. Artifact and readout

- Machine artifact: `evaluation/baselines/YYYY-MM-DD-route-sweep-<label>.json` —
  per case, per route, per model: the payload sent, the raw response, its `provenance`
  block, latency, and error if any. Plus a header with the submodule commit, target,
  both model names, `max_results`, and the QA code version below.
- Human readout: `YYYY-MM-DD-route-sweep-<label>.md` beside it — per route, then per
  case, the two outputs stacked with the diff visible. Mechanical check results at
  the top, so a broken run is obvious before reading.

**Code version in the header.** The routes execute on QA's deployed image, and nothing
reachable reports it — task definitions pin `:latest` and `/api/health` returns only a
package version. So stage two resolves the running image digest once, via
`ecs:describe-tasks` on the QA service (`us-east-2`), and records it. Local
`git rev-parse HEAD` is the obviously wrong proxy here: a sweep run after PR 1 against
a QA task still on the previous image would look clean. If the lookup fails, the header
says **code version: unknown** in the prominent line, not a quiet note.

**Mechanical checks (automatic, no judge).** These are the failure modes a model swap
actually produces, and none need a human:

- `provenance.produced` is true and `provenance.model` echoes what was requested — the
  §0 fallbacks are otherwise invisible, and a same-model run otherwise looks clean
- response parses; required fields present; for array routes `len(outputs) == len(inputs)`
- non-empty output per item
- the frozen retrieval returned documents at all (a zero-doc case is not a row)
- latency per call, against the incumbent's
- errors and timeouts, surfaced not swallowed

Anything structural failing is a green/red line in the readout. Everything else is
for the eye.

### 5. Where the code lives

A new `evaluation/route-sweep/` sibling plus `evaluation/run-route-sweep.ts`, reusing
`evaluation/lib/` conventions and the `evaluation/baselines/` artifact convention.
Two PRs: the knob (four routes + one helper, reviewable on its own) then the tooling.
The knob must be deployed to QA with the token set before stage two can run there.

## Decisions made in conversation

- The bar is a **side-by-side a person reads once**, not a comparable number —
  so: no judge, no threshold, no ground truth.
- Payloads come from **a frozen real retrieval**, not hand-authored fixtures (approach A).

## Calls I made, for checking

- **`evaluation/route-sweep/` as a sibling** rather than a mode inside `evaluation/answer/`:
  that harness is answer-shaped (evalsets, selection modes, judged metrics) and
  bolting route sweeps in would tangle both.
- **400 on an unauthorised override** rather than ignoring it: quiet fallback is how
  a sweep compares a model against itself.
- **Importing the UI's payload builders** rather than reimplementing them: the
  `FORWARDABLE_FIELDS` precedent, where the harness imports the shipped route so it
  cannot drift.
- **Token-gated override, not a boolean flag**: one env var instead of two, and
  absent in production means refused there by construction.
- **`model` echoed in each response**: cheap, and it is what makes provenance a fact
  rather than a claim.

## Known limits

- **The override token's value is in git history and cannot be un-published.** It is written
  into `qa.tfvars` by this work, so anyone with repo read access knows it and could spend the
  shared OpenAI key through the public QA gateway. The gate was designed to bound accidents,
  not adversaries, and that is the accepted position — but it means the value must be treated
  as public: rotate it if it ever needs to be private, and never reuse it outside QA.

- **The batch-why payload the UI actually sends under-informs the route.**
  `SupportingCitations.tsx:159` posts `query: 'answer'` — a generic placeholder —
  because the component does not hold the real query. The sweep should send the real
  question (that is the condition worth testing), which means a clean sweep is
  necessary but not sufficient: users get a worse-conditioned call than the sweep
  tests. Worth its own issue; out of scope here.
- **The token gate bounds accidents, not adversaries.** Anyone with
  `ecs:DescribeTaskDefinition` already reads the OpenAI key from the QA task def. The
  gate stops a stray caller and stops production entirely; it is not a security
  boundary. Moving that key to Secrets Manager is separate tracked work.
- **Fallbacks are a route property, not a model property.** The §0 signal makes them
  visible, but a route that fell back is still a route whose quality this tool cannot
  judge. Repeated fallbacks on one route mean the route needs fixing before its model
  can be meaningfully compared.
- **Two route configs are read at import.** Lifting the model into a per-request
  resolver changes when the value is read; any code caching the const across requests
  must be checked, not assumed.
- **Model names are the caller's responsibility.** The tool reports what it observed;
  it cannot know whether a name is real until the provider answers.

## Left to the builder

- Concurrency default, informed by one measured run rather than guessed.
- Per-call timeout default, measured against the incumbent on QA.
- Whether stage one and two live behind one command or two, per the existing
  `eval:*` script conventions.
- Whether the provenance block is one shared helper or four inline returns, as long as
  every return path in all four routes carries it — including the catch blocks and the
  sanitizer.
- Exact readout layout, as long as one case fits comfortably on a screen and
  mechanical failures are visible before any prose.
