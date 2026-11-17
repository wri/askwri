# Model config: one registry, GPT-6 class models — design

**Date:** 2026-11-12
**Status:** approved 2026-11-12, then revised after an external (Astra) review the same day; the
revised version is the approved one. Implementation runs as a separate SDD session — see
`docs/superpowers/handoffs/2026-11-12-model-registry-sdd-handoff.md`.
**Scope:** replace every OpenAI model in the app tier and the ingestion pipeline with the
GPT-6 class, and collapse model configuration into one reviewable place per service.

## Intent

Two things, one change:

1. **Move to the GPT-6 class.** The models in production (`gpt-5.4-mini`, `gpt-5.4-nano`) are
   a generation behind. The replacement is not a rename: the family changed its parameters,
   its tiers, and its price structure.
2. **One place for model config.** Today a model name can be changed in six places and
   nothing reconciles them: code fallbacks, a GitHub secret blob, two price tables, a cost
   constant in a query module, `.env.example`, and a Terraform variable. Production runs
   `gpt-5.4-mini` while the code says `gpt-4o-mini`, and both are "correct" depending on
   which file you read.

Why now: the deprecation clock on the 5.x line is the forcing function, but the configuration
problem is the reason this is not a one-line change. Every place a model name lives is a place
a migration can miss.

## Goals

1. Every model id the system uses is declared in exactly one file per service, with the
   parameters that model accepts and what it costs.
2. Changing which model runs a task is a one-line, reviewable diff — and an invalid choice
   fails at boot rather than at 3am.
3. Cost and energy accounting follow the model automatically. An unknown model is a loud
   error, never a silent default rate.
4. Every GPT-6 call is exercised before the mapping is trusted.

## Non-goals

- **Key exposure or rotation** — separate workstream, explicitly out of scope.
- **Answer-eval baselines** — out of scope; old and new `judge_model` values are simply
  recorded and not compared.
- **Re-embedding / backfill.** No data migration. Embedding ids come into the registry; the
  vectors stay as they are.
- **Removing the `RETRIEVAL_BACKEND=legacy` boot path.** It is a mode with its own code; it
  only needs its model id to come from the registry.
- **Batch API.** See "Caching and batching" — it is a pipeline rework, not a config change.
- Retrieval tuning, RRF weights, rerank thresholds (existing out-of-scope list).

## Anti-goals

- A migration that "works" by silently degrading: a correct model id with the wrong parameter
  set, or with a sixth of the evidence.
- A second registry that drifts from the first with nothing to catch it.
- Burying the model choice so deep that nobody can tell what runs in production.

## Constraints

- Model ids are `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`. `gpt-6-sol` is
  deliberately excluded. No mini/nano suffix exists in this family.
- **`temperature`, `top_p`, `logprobs` are rejected when reasoning effort ≠ `none`.** So a task
  switched to a GPT-6 model stops sending `temperature`. That happens with the model swap, not
  with the refactor.
- **`none` effort is unsupported on Astra and 6.1-Sol**; supported on Terra and Luna.
- Tool calling on Chat Completions needs `reasoning_effort: "none"` (6-Sol/Luna) or the Responses API.
  **`/api/alignment` has a `tools` rung in its recovery ladder** (`route.ts:556-557`, the
  documented `json_schema → tools → json_object` pipeline). At the mapped `medium` effort that
  rung can never succeed on Chat Completions, so it is removed rather than left as a
  guaranteed-400 detour that burns a timeout-budgeted attempt before `json_object`. GPT-6
  supports Structured Outputs, so the `json_schema` rung stays.
- All four models: 1.05M context, 128K max output, Chat Completions + Responses + Batch.
- Prices, per 1M tokens, short context (≤272K): Astra $10/$50 (cached $1.00), 6.1-Sol $2/$10
  ($0.10), 6.1-Terra $1/$5 ($0.05), Luna $0.10/$0.50 ($0.01). Long context (>272K) costs more;
  our prompts are ~4–15K so it does not apply.
- **This change must not deploy before `feat/route-model-sweep` merges.** That branch adds the
  `provenance` block that makes substituted output visible; shipping the model family change
  first would hide every fallback at the worst moment.
- QA and production share one OpenAI key, so one access probe answers for both.

## Approaches considered

**A. A registry module per service. *(chosen)***
One file per service: the model table (id, tier, parameters accepted, price, dimensions) and a
task→model table, with one `resolveModel(task)` reading only that. Every consumer reads it;
the model env vars are deleted.

**B. One JSON file at the repo root, read by both services.**
Literally one place across languages, but `search-service/Dockerfile` copies only `app/`,
`worker/`, `requirements.txt` and `start.sh`, so this needs a build-context change in the
deploy workflow, and it loses TypeScript types unless wrapped.

**C. Keep env as the source of truth, add validation.**
Smallest diff and preserves no-deploy model changes — but production model choice stays
outside code review, which is the exact property that produced the current drift.

A was chosen because it is the only option that kills all six scattered surfaces, and because
the failure modes that matter here (silent default pricing, string-matched capabilities) are
code-shaped, not config-shaped. It carries two amendments from the premise audit:

- **Keep one validated env lever** (`OPENAI_MODEL_<TASK>`) so a bad model can be backed out
  without a full deploy. The value space is closed — it must name a registry id, or the
  process fails at boot — so it cannot reintroduce drift.
- **Emit a test-only JSON fixture** from the TS registry, which the Python tests assert
  against. That buys B's cross-language guarantee without the Docker plumbing, because the
  fixture is never read at runtime.

## Design

### 0. Refactor versus migration — the line this design must not blur

Three things are bundled in the phrase "move to GPT-6", and they must happen in this order
because each is safe only after the previous one:

| | Changes | Proves itself by |
|---|---|---|
| **Refactor** | where model ids and request parameters come from — nothing else | the request bytes sent upstream are unchanged |
| **Probe** | nothing; it only observes | a recorded matrix of accept / reject, usable / unusable, latency, reasoning-token share |
| **Migration** | the model a task runs, its effort, and (only then) the parameter changes that family forces | a per-task capture with zero fallbacks and a human read of the side-by-side |

Anything that changes what we send belongs to migration, however convenient it would be to do it
while the refactor is open. Conflating them is how a "refactor" silently becomes a model change
that nobody gated.

### 1. The registry (`src/config/models.ts`)

```ts
type ModelId = 'gpt-6-astra' | 'gpt-6.1-sol' | 'gpt-6.1-terra' | 'gpt-6-luna'

type ModelSpec = {
  id: ModelId
  tier: 'flagship' | 'balanced' | 'fast' | 'volume'
  contextTokens: number          // 1_050_000
  maxOutputTokens: number        // 128_000
  supportsEffortNone: boolean    // false for astra, 6.1-sol
  // Reasoning models reject temperature when effort is not none; dropped at migration time.
  price: { inputPer1M: number; outputPer1M: number; cachedInputPer1M: number }
}
```

A second table maps tasks to a model, an effort and the budgets that used to be derived from
`isGpt5`. In the refactor stage, `effort` is declared but **not sent**, and the budget fields
carry the formulas the routes already use rather than one number each:

```ts
interface TaskSpec {
  model: ModelId
  effort: Effort                    // declared now, sent only when the model is switched
  budget: (input: { passages?: number; documents?: number; attempt?: 'primary' | 'repair' }) => number
  maxPassages?: number              // answer synthesis only
  passageChars?: number             // answer synthesis only
  timeouts?: { baseMainMs: number; baseRepairMs: number }   // bases; scaing + clamps stay in code
}
```

**Timeouts move here too.** Every analysis route derives its client timeout ladder from
`isGpt5` today (`alignment-config.ts:20-21` → 40s/25s vs 20s/12s, then bound by the ALB's 300s
`idle_timeout`). `isGpt5` disappearing would otherwise leave that ladder with no owner. The
seeded values are the GPT-5 ladder carried over **provisionally** — there is no GPT-6 latency
data in this repo — and the sweep records per-call latency, so the first post-deploy sweep is
what re-seeds them.

**The passage budget moves here deliberately.** `answer-synthesis.ts` currently decides
15 passages × 800 chars for the GPT-5 class and 6 × 350 otherwise, and a `gpt-6-*` id would
match neither — handing the answer route one-sixth of the evidence while every parameter was
still legal. Putting `maxPassages`/`passageChars` on the task makes that impossible to lose.

### 2. Task → model

| Task | Model | Effort |
|---|---|---|
| Answer synthesis | `gpt-6.1-sol` | `medium` |
| Alignment | `gpt-6.1-terra` | `medium` |
| Why / batch-why | `gpt-6-luna` | `none` |
| Relates / batch-relates | `gpt-6-luna` | `none` |
| Translate | `gpt-6-luna` | `none` |
| Answer nano pre-filter | `gpt-6-luna` | `none` |
| Worker summaries + tagging | `gpt-6-luna` | `none` |
| Query understanding LLM | `gpt-6-luna` | `none` |
| Eval judge | `gpt-6-astra` | `medium` |

Per-task output budgets are **not** one number each. Today they are formulas: answer
`max(2000, OPENAI_MAX_TOKENS)` for the GPT-5 class; translate 2 000; prefilter 500; why
`min(200 + 80 × passages, 3000)`; relates `max(1000, 120 × documents)`; alignment 4 000 primary
and 5 000 repair. Those formulas move into the registry as formulas. Collapsing them to a
scalar per task would change the smallest budgets and the largest, in opposite directions.

(A correction: `OPENAI_MAX_TOKENS=1200` does **not** cap everything. For the GPT-5 class each
route raises it — answer to at least 2 000, alignment to 4 000/5 000 — so treating 1 200 as the
ceiling would cut real budgets. The env var's only universal effect is on the non-GPT-5 branch.)

### 3. Request construction

`isGpt5` disappears rather than being renamed. Nothing string-matches a model family any more —
but **the parameters each request carries do not change at the same time as the model does.**
Two separate steps:

**At refactor time (no behaviour change):** each route asks a request-profile builder for its
parameters, given the task, the attempt (`primary` | `repair`) and the input size. The builder
returns the same numbers, temperatures and omitted fields the route sends today.
`reasoning_effort` returns `undefined` and is not sent, because today's payload builders omit it
and adding it — even at a provider default — is a behavioural change.

**At migration time (deliberate, measured):** for a task switched to a GPT-6 model —

- `max_completion_tokens` instead of `max_tokens`;
- `temperature` dropped, since the family rejects it when effort ≠ `none`;
- `reasoning_effort` supplied from the task's `TaskSpec.effort`;
- the passage budget from `TaskSpec`, so a candidate cannot silently inherit the smaller one.

The per-request override from `feat/route-model-sweep` still wins when the sweep supplies one.
Effort is a property of the **task**, not of the model, so an override inherits the task's
effort; an override naming a model that cannot run that effort is a request-time error, not a
boot-time one — the route is already running.

**The closed value space applies to task resolution, not to every caller.** Surfaces that
intentionally accept a model id the registry does not know:

- `/api/answer` reads `body.model` + `body.base_url` (`answer-synthesis.ts:30`) — the answer
  eval harness's cross-provider candidate flow depends on it.
- `evaluation/answer/judge-client.ts` takes `--judge-model`, default `glm-5.2-vision`.
- The route-sweep override.

So the builder is one function, but the **fallback profile is per caller, not one blanket
arm**: the judge's non-GPT arm is `max_tokens` + `temperature: 0`, while each route's
configured temperature differs (answer 0.3, translate 0.2, prefilter 0.1, relates and
alignment configured, batch-why 0.3 and its GPT-4o arm uses `max_completion_tokens`). Merging
them into a single "legacy profile" would change several real requests. The eval arm is
documented as unsupported in production; a comment does not enforce that, so it is validated
where the caller is known — the judge is the only production-adjacent caller and it does not
run in the request path.

### 4. Consumers that stop keeping their own copy

Only the request path is in the refactor stage. The two cost/energy rows below are the same
change in kind but carry their own risk (they change what the UI reports), so they are their
own chore — done before any model is switched, but not inside the byte-equality promise.

| File | Today | After |
|---|---|---|
| `src/config/costs.ts` | own price map keyed `openai/…`, unknown → gpt-4o-mini rate | prices from the registry; unknown model throws |
| `src/config/energy.ts` | `GPT_5`/`GPT_4O`/`GPT_4O_MINI` factor table + `OPENAI_MODEL` fallback | factors keyed by registry `tier` |
| `src/db/queries/topicsAdmin.ts` | hardcoded per-doc cost from a 5.6-luna price | derived from the registry |
| `src/app/utils/utils.tsx` | hardcodes `openai/text-embedding-3-small` for the cost estimate | **the active embedder**, so the figure stops being wrong as well as unsourced |
| `src/lib/alignment-protocol`-adjacent ladder | `json_schema → tools → json_object` | `json_schema → json_object` (see Constraints) |
| `evaluation/answer/judge-client.ts` | own `/^gpt-5/i` mirror | `requestProfile()` — its own non-GPT arm, unchanged |
| 5 route files + `answer-synthesis.ts` + `chat-completions.ts` | their own consts and `isGpt5` | `resolveModel(task)` |

The `openai/` prefix on cost keys is currently load-bearing — `alignment` stamps
`` model: `openai/${cfg.model}` `` before returning usage, and nothing documents it, so any new
route that forgets silently mis-bills. The registry owns that mapping instead.

### 5. Python side (`search-service`)

Same two tables in `app/config.py`, which already holds the model ids in one place:

- `config.py` becomes the single source for chat models, `worker_llm_model`,
  `embedding_model` and `bedrock_embed_model_id`, plus `query_translation_model` — the one
  chat model currently declared there with no task-table row (its lane is dark; it maps to
  Luna at `none`, and the "gpt-5-mini's measured latency made the 3s timeout unusable"
  comment must be re-worded, because a silent model swap invalidates it).
- `usage_meter.py` reads prices from `config.py` instead of keeping its own table.
- The worker's dead legacy embedder goes: `LEGACY_EMBEDDING_MODEL` and `_embed_texts` are
  unreachable (both DBs hold 35,449 chunks and 958 tag embeddings, all `cohere-embed-v4`; both
  task definitions run `RETRIEVAL_BACKEND=postgres` with no `EMBEDDING_MODEL` set).
- `worker/stages/classify.py:172` stops hardcoding `'cohere-embed-v4'` inside a SQL string and
  takes the active id as a parameter.
- The legacy-retrieval-boot embedder keeps its id via a registry entry marked `active: false`,
  so the exception is declared rather than silent.

### 6. Cross-language guard

A script emits `config/models.fixture.json` from the TS registry. The TS tests assert the
registry matches it; the Python tests assert `config.py` matches it. A one-sided edit fails a
test in the other language. The fixture is never read at runtime.

The fixture asserts the **full universe**, not a chat-only subset — otherwise the ids it omits
are exactly the ones free to drift. That means registry entries carry a pricing discriminator,
because the non-chat ids are priced differently:

```ts
type Price =
  | { unit: 'per_token'; inputPer1M: number; outputPer1M: number; cachedInputPer1M: number }
  | { unit: 'per_query'; per1kQueries: number }          // cohere.rerank-v3-5:0
```

Note the two-ids-one-embedder wrinkle: `cohere-embed-v4` is the per-row
`document_chunks.embedding_model` value, while `cohere.embed-v4:0` is the Bedrock model id.
Both are registry fields of one entry, not two entries.

### 7. Access probe

`scripts/probe-models.ts`: for each **named call profile** — `answer`, `prefilter`, `why`,
`relates`, `translate`, and alignment's three attempts (`schema`, `tools`, `json_object`) — at
the effort that job is actually planned to run at, one request with the body that profile really
sends. Reports two separate verdicts: did the API accept it, and is the output usable (non-empty,
complete, `finish_reason` not `length`, and parseable into the shape the route expects). A
trivial completion would prove none of that — and note the answer route sends **no**
`response_format` at all (it asks for JSON in the prompt), so a probe built around
`response_format` would be testing a request we never make.

The default run is the intended matrix (task × candidate × effort), not every pairwise
combination, and it exits non-zero when a required case fails so it can gate a release. One
timing sample is an observation, not a latency baseline.

### 8. Caching and batching

- **Prompt caching** is automatic above 1,024 tokens with a stable prefix; our system prompts
  qualify, so some input is already billed cached. Nothing to build. We set no
  `prompt_cache_retention`, so the migration note about replacing it with
  `prompt_cache_options.ttl` is a no-op.
- **Batch API** halves every price but only suits offline work. The worker is `chat_json` per
  document inside a queue-driven pipeline with content-hash dedup and status transitions;
  Batch means submit/poll/reconcile, a rework with its own failure modes, for 50% of Luna's
  already-tiny bill. Separate spec, not this change.
- **Translate batching is a product change, not config**: the UI sends one snippet per call,
  so a citation card with six foreign snippets is six calls. Worth a follow-up issue.

### 9. Rollback

Revert the commit and redeploy, or set `MODEL_<TASK>` to another registered id — a restart, not
an image build. The env lever exists for exactly this and is validated against the registry, so
it cannot point at a model the code cannot describe.

**The levers get new names on purpose** (`MODEL_ANSWER`, `MODEL_WHY`, … rather than reusing
`OPENAI_MODEL*`). The deployed `ASKWRI_APP_ENV` blob today holds `OPENAI_MODEL=gpt-5.4-mini`,
`OPENAI_MODEL_WHY`/`_RELATES`/`_ALIGNMENT=gpt-5.4-nano`; under boot validation those stale
values would boot-loop a service the moment the code lands, and the same secret feeds QA and
production, so it cannot be staged per environment. New names make every stale value inert
(the code simply does not read it), which turns a coordinated repo-external step into a
no-op. Deleting the old keys from the blob is then ordinary cleanup, not a release gate.

### 10. Sequence

Six steps, in plain terms. Each is finished and checked before the next starts.

1. **Ask the new models whether we can use them.** One test call per model, shaped like the
   requests we really send. Nothing under `src/app` changes. Tells us: do we have access, do
   they accept our parameters, how fast they are, and how much of the reply budget the model
   spends thinking instead of answering.
2. **Move the model settings into one file, changing no model.** Every route reads its settings
   from the registry and every model stays exactly as it is today. We prove nothing moved by
   recording the request each route sends before the change and requiring the same bytes after.
3. **Run the old and new models side by side on QA.** Real questions from the eval set, both
   models, outputs shown next to each other. Users keep the old model throughout.
4. **Switch one job at a time** — translate first, answer synthesis last. One line per switch,
   gated on the acceptance bar below, reversible with a restart.
5. **Move the ingestion worker separately**, since it is its own deployment.
6. **Clean up** — legacy embedder, dead env vars, stale secret keys, docs.

Steps 1 and 2 are one plan. Step 3 needs its own, because what it measures depends on what
step 1 finds.

**Acceptance bar for switching any single job:** probe ✓ for that job's request shape at its
planned effort; 10-case capture with zero fallbacks and zero parse failures; every array length
matching the input count; p95 latency under 60% of that job's timeout; cost within 20% of the
incumbent's; and a human read of the side-by-side showing no regression on what that job is for.

## Decisions made in conversation

- Approach A, with the validated env lever and the test-only cross-language fixture.
- Four ids only; `gpt-6-sol` is out.
- Answer synthesis → Sol (≈$0.013/answer at 15×800 chars, so cost is not the deciding factor).
- Alignment → Terra at **medium** effort.
- Astra, for the eval judge only.
- Embedding ids are in the registry; **no** re-embedding.
- Answer-eval baselines and key exposure are out of scope.

## Calls I made, for checking

- **`temperature` is dropped at migration time**, not at refactor time. It is legal on
  `none`-effort tasks but nothing needs it, and one fewer knob is one fewer way to send an
  illegal request. Keeping the two steps separate is what lets the refactor claim identical
  requests.
- **Effort lives on the task, not the model**, because the same model can be used at different
  efforts and the legality differs per model.
- **The legacy embedder leaves the worker but stays in the registry** as `active: false`. Zero
  rows use it and no task definition selects it, so deleting the code is safe; deleting the
  id would not be, because `RETRIEVAL_BACKEND=legacy` still references it.
- **`OPENAI_MAX_TOKENS` and `OPENAI_TEMPERATURE` are deleted**, so the task-definition env
  stops being a second place a model's behaviour is configured.
- **`worker_llm_model` leaves Terraform.** The worker's model becomes registry data, which
  means a worker model change now needs a deploy. That is the trade for having one place.
- **Unknown model = throw**, in `costs.ts` as well as in resolution. The current silent
  fallback to gpt-4o-mini pricing is how a cost dashboard goes quietly wrong.
- **The levers are renamed at migration time** (`MODEL_<TASK>`) instead of reusing
  `OPENAI_MODEL*`, so the stale values in the deployed secret blob become inert and a release
  needs no coordinated repo-external step. The refactor stage introduces no lever at all and
  leaves today's precedence untouched.
- **The `tools` rung is deleted from alignment's recovery ladder** rather than kept as a rung
  that cannot succeed at `medium` effort on Chat Completions.
- **Eval-only callers keep an explicit legacy param arm** instead of the registry rejecting
  them, because the answer harness's cross-provider candidates and the GLM judge depend on
  sending ids the registry does not own.
- **Task timeouts join the registry** instead of staying per-route, since they were the last
  `isGpt5` consumer with no replacement.
- **The probe exercises each task's real request shape**, not one trivial completion — the
  thing that can fail silently is a structured-output request at a given effort.
- **The fixture asserts the full model universe**, with a `per_query` price variant for the
  reranker, so the ids it omits cannot be the ones that drift.
- **`utils.tsx`'s cost estimate switches to the active embedder**, making the figure correct
  as well as sourced — today it prices an OpenAI model that writes no rows.

## Known limits

- **The probe cannot prove production access** if the keys ever diverge; it proves the org.
- **Timeouts are provisional.** The seeded ladders are the GPT-5 bases scaled by prompt size;
  no GPT-6 latency exists in this repo yet, and a wrong-low value turns a slow call into a
  plausible canned answer. Moving the bases into a table must not move the scaling with them —
  the 40 s / 25 s values are starting points that the code already scales and clamps to 60 s /
  50 s.
- **The per-caller eval fallback is a documented hole in the closed value space.** It exists so
  the GLM judge and cross-provider candidates keep working; it is not a production path, and a
  comment does not enforce that.
- **A model change now needs a merge and a deploy**, except through the validated env lever.
  That is the accepted cost of reviewability.
- **Prices are list prices** from OpenAI's pricing page; a contract rate would need a field.
- **`energy.ts` factors are invented per tier.** The existing table was already labelled
  "tune with real telemetry"; moving it to tiers does not make it measured.
- **Long-context pricing is not modelled.** Our prompts are ~4–15K, far under the 272K
  boundary; if a prompt ever crosses it, the cost table under-reports.
- **The judge moving to Astra** changes judge spend and latency, and makes old and new
  answer-eval baselines non-comparable. Both accepted as out of scope.

## Left to the builder

- Exact per-task `maxOutputTokens` values, seeded from today's effective caps.
- Whether `resolveModel` reads the env lever at module load or per call (it must fail at boot
  either way).
- Where the fixture-emitting script lives and whether it runs in CI or on demand.
- Table/file layout inside `config/models.ts` — one file is the requirement, not one section.
