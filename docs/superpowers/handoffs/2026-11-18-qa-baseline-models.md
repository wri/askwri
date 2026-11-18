# What QA actually runs — route model baseline

**Measured:** 2026-11-18, against `https://qa.askwri-app.org`, serving image
`askwri-app-qa:6ad67fc040eaf21e0dc0c87e9abc757ec571228e` (the merge of #485), one running task,
`desiredCount == runningCount == 1`, task definition `askwri-app-qa:271`.

**Why this exists:** the route models arrive through `OPENAI_MODEL*` in the app task definition's
secret blob (`.github/workflows/deploy-qa.yml:197`), so no file in this repo states them. Every
acceptance gate compares a candidate against the model a job runs *today*, and the `MODEL_<TASK>` swap
is only safe if the registry already holds these values. Both were assumptions until this run.

**Method:** one request per route with **no** `model` field, so each route resolves its own configured
model, then read back the id the response names. Four swept routes: `provenance.model` (added on all four
by #486). Answer synthesis has no `provenance`, so its id comes from `debug.knobs.model`. Documents came
from one frozen cite retrieval (`npm run eval:routes -- --stage freeze --label idsprobe --limit 1`), and
payloads were built with the shipped builders in `evaluation/route-sweep/payloads.ts`.

## Deployed model per task

| Task | Deployed on QA | Code default (`ASSIGNMENT`) | Agree? |
|---|---|---|---|
| answer synthesis | `gpt-5.4-mini` | `gpt-5.4` | **no** |
| answer nano pre-filter | *unobservable* — see below | `gpt-5.4-nano` | unknown |
| why / batch-why | `gpt-5.4-nano` | `gpt-4o-mini` | **no** |
| relates / batch-relates | `gpt-5.4-nano` | `gpt-4o-mini` | **no** |
| alignment | `gpt-5.4-nano` | `gpt-4o-mini` | **no** |
| translate | `gpt-5.4-mini` | `gpt-5-mini` | **no** |

Answer also reported its live knobs: `max_passages=15`, `passage_chars=800` — the GPT-5-class arm,
consistent with `modelCapability('gpt-5.4-mini')` falling through to the `/^gpt-5/i` test.

**The pre-filter cannot be observed.** It runs only when `USE_NANO_FILTER=true`
(`src/app/api/answer/route.ts:25`), and the deployed fleet answers with it off: the frozen case sent 3
passages and the route reported no pre-filter step. Its configured id is therefore
`OPENAI_MODEL_NANO ?? 'gpt-5.4-nano'`, unverified. Its flip is unevidenced until that flag is on.

## What this changes

1. **`gpt-5.4-mini` is not in the registry.** `ModelId` holds `gpt-4o-mini`, `gpt-5-mini`, `gpt-5.4`,
   `gpt-5.4-nano` and the four candidates. Two of six tasks run an id the registry cannot describe, so
   `ASSIGNMENT` cannot be corrected to match QA without adding it (capability **and** price — the cost
   gate needs one, and Task 4 prices every assigned model).
2. **Five of six `ASSIGNMENT` rows are wrong** relative to production. That is the drift the design's
   Intent section describes, now measured rather than asserted: "Production runs `gpt-5.4-mini` while the
   code says `gpt-4o-mini`, and both are correct depending on which file you read."
3. **The lever swap is not free.** Replacing the `OPENAI_MODEL*` reads with `MODEL_<TASK>` before
   correcting `ASSIGNMENT` would have moved five jobs onto different models, in one deploy, with no gate —
   the exact failure §0 exists to prevent.

## How to re-run it

```bash
npm run eval:routes -- --stage freeze --label idsprobe --limit 1 \
  --model-a gpt-5.4-nano --model-b gpt-5-mini      # both models are required even for a freeze
# then one POST per route with the frozen case's payload and no `model` field:
#   /api/batch-why, /api/batch-relates, /api/alignment, /api/translate → .provenance.model
#   /api/answer → {query, docs} → .debug.knobs.model
```
