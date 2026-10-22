# Block switches — design

**Date:** 2026-10-15
**Status:** design. Nothing here is approved for build.
**Builds on:** `2026-10-15-building-blocks-design.md` §4 (the labelling discipline). The owner chose
to design this next, out of the two options offered.

## 1. Problem

"Answer mode is a block" is a word, not a thing. To hide answer mode today you have to know it is a
mode string in `search-service/app/main.py`, a preset in `src/config/retrieval.ts`, a modal in
`src/app/components/AnswerMode/`, and a feedback route at `src/app/api/answer-mode-feedback/` — and
then find every place that renders or calls them. There is no list of blocks and no single switch.

The consequence is the one the exploration record names: the team can never hand a block over,
because there is nothing to hand over that a recipient could switch.

## 2. What exists

| Tier | Gating today |
|---|---|
| Server (Python) | seven scattered booleans in `search-service/app/config.py`: `translation_pairs_enabled`, `query_translation_enabled`, `query_understanding_enabled`, `query_expansion_lanes_enabled`, `query_understanding_llm_enabled`, `answer_translation_enabled`, `classify_topic_only` |
| Worker | one: `classify_topic_only` |
| App (Next.js) | **none**. `NEXT_PUBLIC_ENVIRONMENT` is the only public env var, and it is not a feature gate |

So the mechanism is not half-built — it is built for some server-side tunables and absent everywhere
else. Every block that has a UI half currently cannot be hidden at all.

## 3. Design

### 3.1 One switch, additive

A single environment variable, `DISABLED_BLOCKS`, holding a comma-separated list of block names.
Unset means everything on, which keeps every existing deployment byte-for-byte unchanged and makes
misconfiguration fail toward "nothing disappeared".

Deliberately **not** `ENABLED_BLOCKS`: an allowlist turns an unset variable into an empty product.

Read in both tiers: `search-service/app/config.py` for the server and worker, and the app's own env
read (deploy sets both; the app additionally exposes the resulting list to client components so
surfaces can be hidden before render).

### 3.2 The register

One declared list, one file per tier, same names: `BLOCKS` in
`search-service/app/blocks.py` and `src/config/blocks.ts`. Each entry declares:

| Field | Meaning |
|---|---|
| `name` | lowercase, stable, used in `DISABLED_BLOCKS` and in every tier |
| `kind` | `core` or `additional` |
| `requires` | names of blocks this one needs; enabling a block whose requirement is disabled is a startup error |
| `routes` | server or app route paths this block owns |
| `stages` | worker stages it adds, if any |
| `surfaces` | app components/pages that must not render |
| `config_keys` | the block's own tunables, so they are read only when it is enabled |

The two registers are checked against each other by a test that fails on a name present in one tier
and missing from the other. That test is the thing that stops the list rotting.

Seeded from the exploration record: the five core blocks are `corpus`, `ingestion`, `retrieval`,
`read-api`, `label-review`; the additional ones are `answer`, `cite-presentation`, `experts`, `mcp`,
`multilingual`, `query-understanding`, `tagging`, `relations`, `collections`, `eval`,
`judgment-capture`.

### 3.3 What "hidden" means, per tier

- **Server routes:** a disabled block's routes are not registered. A caller gets 404, not an empty
  list.
- **Worker stages:** a disabled block's stages are not scheduled; the pipeline runs without them.
- **App surfaces:** not rendered, and the entry point (button, chip, nav item, suggestion) is absent
  rather than disabled-looking.
- **Config keys:** a disabled block's tunables are not read, so a stale value in an instance's env
  cannot affect behaviour.

**Call: hidden means refused.** Hiding a block removes its routes rather than 404-ing a live handler,
so a hidden block is genuinely absent to a caller, not merely invisible. Without this, "hidden" is a
UI convention that any script can walk around.

**Call: core blocks cannot be disabled.** Attempting it is a startup error. The minimum viable
product is the product; a configuration that disables the corpus store has no meaningful behaviour to
define.

**Call: the register lives in code, not the database.** Unlike dimensions, a block is code — its
entries can only be correct if they match the routes and components that actually exist, so the
compiler and the tests should be able to see them.

### 3.4 Dependency errors fail loud

Disabling `retrieval` while enabling `answer` must fail at startup with both names, not produce an
answer mode over nothing. Dependencies are declared per block and checked once, at boot.

## 4. Acceptance tests

1. Set `DISABLED_BLOCKS=answer` on a running instance: the answer route returns 404, the modal and
   its entry point do not render, and cite mode is unaffected.
2. Set `DISABLED_BLOCKS=retrieval`: startup fails, naming `retrieval` as core.
3. Set `DISABLED_BLOCKS=retrieval` with `answer` enabled: startup fails, naming both and the
   dependency.
4. Add a block name to one tier's register only: the cross-tier test fails.
5. Unset `DISABLED_BLOCKS`: every route, stage and surface an instance has today is present,
   unchanged.

## 5. What this design is not

It does not make blocks separable — the code still ships, as the owner chose ("present but hidden").
It is not a plugin registry, and modules are not discovered at runtime. It does not change the
`/query` contract. It does not touch dimensions, taxonomy, or classification.

## 6. Left to the builder

The exact shape of the register entries, how the app passes the disabled list to client components,
whether route registration is dynamic or checked at request time, the test harness for the
cross-tier check, and the naming of the individual route/component fields.

## 7. Open for the owner

One question only: **the block names and the core/additional split** in §3.2 are my reading of the
exploration record. The names become public vocabulary — they appear in config, in docs and in any
later handover — so they are worth renaming now rather than after use.
