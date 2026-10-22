# Block switches — design

**Date:** 2026-10-15
**Status:** design, revised after a builder check. Nothing here is approved for build.
**Builds on:** `2026-10-15-building-blocks-design.md` §4 (the labelling discipline). The owner chose
to design this next, out of the two options offered.

## 1. Problem

"Answer mode is a block" is a word, not a thing. Hiding answer mode today means knowing that it is
not a route at all:

- a **mode value** inside `/query` — `mode: str = "cite"  # "answer" or "cite"` (`main.py:148`),
  branched on seven times through the handler
- a preset (`ANSWER_PRESET`) in `src/config/retrieval.ts`
- a component tree under `src/app/components/AnswerMode/`
- entries in `Landing/index.tsx:172`, `results/page.tsx:30`,
  `components/results/ResultsTable.tsx:256`, `QuerySuggestions/suggestionPool.ts:38`
- five app routes: `/api/answer`, `/api/alignment`, `/api/answer-mode-feedback`,
  `/api/answer-mode-query-logs`, and half of `/api/batch-why`

There is no list of blocks and no single switch, so the team can never hand a block over: there is
nothing a recipient could switch.

**The structural finding that shapes this design: blocks do not all attach the same way.** Some own
routes. Some are a value on a shared route, or a branch inside one. Some are worker stages. Some are
only a surface. Some have no runtime presence at all. A register that can only name route paths
cannot express answer mode — which is why the first draft of this document was wrong.

## 2. What exists

| Tier | Gating today |
|---|---|
| Server (Python) | seven *gating* booleans out of thirteen in `config.py`: `translation_pairs_enabled`, `query_translation_enabled`, `query_understanding_enabled`, `query_expansion_lanes_enabled`, `query_understanding_llm_enabled`, `answer_translation_enabled`, `classify_topic_only` |
| Worker | one (`classify_topic_only`), plus behaviour gates that belong to blocks: `force_reparse`, `parse_backend`, `reclassify_poll_first` |
| App (Next.js) | **no public feature-flag mechanism**. `NEXT_PUBLIC_ENVIRONMENT` is the only public var and it is baked at build time. There are real gates, but they are private and ad hoc: `USE_NANO_FILTER` (`src/app/api/answer/route.ts:22`), `MCP_SHARED_KEY` (fail-closed) |
| Server routing | `main.py` registers routes directly; `app/routers/` exists and is empty — there is no router layer to unregister from |

So the mechanism is not half-built. It exists for a handful of server tunables and nowhere else, and
every block with a UI half currently cannot be hidden at all.

## 3. Design

### 3.1 One switch, additive

One environment variable, `DISABLED_BLOCKS`, comma-separated block names. Unset means everything as
today — every existing deployment keeps behaving identically, including the seven booleans that
default `False`. Deliberately not `ENABLED_BLOCKS`: an allowlist turns an unset variable into an
empty product.

**Block enablement is orthogonal to tunables.** Turning a block on never turns a feature on; the
block's own switches inside it keep their own defaults.

### 3.2 The register

One declared list per tier, same names: `BLOCKS` in `search-service/app/blocks.py` and
`src/config/blocks.ts`.

| Field | Meaning |
|---|---|
| `name` | lowercase, stable, used in `DISABLED_BLOCKS` and in both tiers |
| `kind` | `core` or `additional` |
| `requires` | blocks this one needs; enabling a block whose requirement is disabled is a boot error |
| `attach` | how the block reaches the system — see §3.3 |
| `routes` | route paths it owns, if any |
| `modes` | values it contributes to a shared route, e.g. `answer` on `/query` |
| `stages` | worker stages it adds |
| `surfaces` | app components and pages that must not render (admin included) |
| `config_keys` | its tunables, so they are read only when the block is enabled |

**Two register rules, and they are what stop it rotting:**

1. **Exactly one owner per route.** A route with no owner, or two, fails a test. Co-ownership is not
   expressible, which is the point: it forces a decision on the dual-candidate routes in §4.
2. **Coverage is declarative, enforcement is lazy.** Every route, stage and surface is *claimed*,
   because a claim is one line in a file. Enforcement is only exercised for the block an instance
   actually disables. This is what keeps an exhaustive register from becoming a 100-route gating
   project.

A cross-tier test fails if a block name exists in one register and not the other.

### 3.3 What "hidden" means, per attachment kind

| `attach` | Hiding means | Observable result |
|---|---|---|
| `routes` | route is not registered | 404 |
| `modes` | the core route **refuses the mode value** | 400, with the block named |
| `stages` | stage is not scheduled | pipeline runs without it |
| `surfaces` | component does not render, entry point absent | nothing to click |
| `none` | nothing is enforced | name and ownership only |

**Call: the mode refusal is not a contract change.** `QueryRequest` and `QueryResponse` keep their
exact shape; a disabled block's mode value simply joins the set of requests the service rejects. The
repo rule about preserving `/query` is about the wire contract, and refusing a request does not
alter it. `/api/llamaindex`, the shared app gateway, carries the same guard, since it proxies both
modes.

**Call: hidden means refused on the server.** A hidden block is absent to a caller, not merely
unrendered. Without that, "hidden" is a UI convention any script walks around.

**Call: enforcement lives at runtime on the server; the app's gate is cosmetic.** The app bakes its
list at build time, matching the existing `Dockerfile`/`next.config.js` precedent, so a running
instance's surfaces cannot be flipped without a rebuild. That is acceptable precisely because the
server is the enforcement point — a stale app shows nothing a caller can use.

**Call: a disabled block's tunables are ignored silently**, never a boot failure. Disabling a block
must be a safe ops action; a stale `QUERY_UNDERSTANDING_ENABLED=true` in an environment (as qa has
today) must not take a deploy down. Only structural mistakes are loud (§3.4).

### 3.4 Loud failures

- Disabling a `core` block → boot error naming it.
- Disabling a block that another enabled block `requires` → boot error naming both (e.g. `retrieval`
  off with `answer` on).
- A route claimed twice, or claimed by nobody → test failure.

**Call: the register lives in code, not the database.** A block is code; its entries are only
correct if they match routes and components that exist, so the compiler and the tests must see them.
Dimensions are the opposite case and stay in the database.

## 4. Ownership assignments (my calls, from the builder check)

| Contested item | Owned by | Why |
|---|---|---|
| `/api/mcp` | `mcp` (additional) | This amends the exploration record's read-surface row, which listed the MCP route under the core read surface. The core read surface is `/query`; MCP is a block and must be hideable. |
| `/api/llamaindex` | `retrieval` (core) | It is the shared gateway for both modes; it carries the mode guard rather than being owned by `answer`. |
| `translation_pairs_*` | `multilingual` | Cross-lingual sibling linking. |
| `relate.py`, `relation_*_threshold` | `relations` | Document-to-document linking, unrelated to language. |
| `src/app/admin/review`, `/api/admin/review-queue`, `/api/admin/documents/[id]/tags` | `label-review` (core) | Human correction is core. |
| `/api/admin/topics*`, `classify`/`embed_tags` stages, tag taxonomy admin | `tagging` (additional) | Machine labelling and taxonomy depth, not review. |
| `/api/translate` | `multilingual` | — |
| cite feedback and cite query-log routes | `retrieval` (core) | Cite *is* core (§8): the trust layer — floors, tiers, caps, grouping — is the product's promise, not a block. |
| `/api/answer-mode-feedback`, `/api/answer-mode-query-logs` | `answer` | They exist to serve answer mode. |
| `alignment` | `answer` | Called from both modes; the one place hiding over-reaches — noted, accepted, because alignment without answer mode serves nothing. |
| "why relates" chips (`/api/batch-relates`, `/api/batch-why`) | `relations` | An LLM enrichment with cost and latency, genuinely optional. |

## 5. Acceptance tests

1. `DISABLED_BLOCKS=answer`: `POST /query` with `mode:"answer"` → **400 naming `answer`**; `mode:"cite"`
   → unchanged results; `/api/answer` → 404; no answer entry point renders.
2. `DISABLED_BLOCKS=retrieval` → boot fails, naming `retrieval` as core.
3. `DISABLED_BLOCKS=retrieval` with `answer` enabled → boot fails, naming both.
4. A route claimed by two blocks, or by none → test fails.
5. A block in one register but not the other → test fails.
6. Unset `DISABLED_BLOCKS` → every route, stage and surface present and unchanged, including the
   seven booleans that default `False`.

## 6. What this design is not

Not separability — the code still ships, as the owner chose ("present but hidden"). Not a plugin
registry; nothing is discovered at runtime. No `/query` wire-contract change. Nothing about
dimensions, taxonomy or classification.

## 7. Left to the builder

The exact register entry shape; how `main.py`'s direct route registration becomes unregisterable
(router extraction or a request-time guard); how the app passes its baked list to client components;
the test harness for the ownership and cross-tier checks; whether `DISABLED_BLOCKS` reaches the app
as a Docker build arg or a generated file.

## 8. Settled after the cite question

**Cite is core, not a block.** Floors, tiers, per-document caps and grouping are a trust mechanism —
the product vision's whole premise is that the plausible wrong answer is the enemy, and an unfiltered
passage list produces exactly that. So `cite-presentation` is not a block: its parts fold into core
`retrieval`, and the core's results view keeps relevance labels and page links.

**"Why relates" chips are not cite.** They move to `relations` — an LLM enrichment with cost and
latency, optional.

**`judgment-capture` is dropped** as a block. Feedback and query-log routes are machinery serving a
capability rather than a capability anyone switches; they are claimed by the block that uses them
(§4). Keeping a block with no runtime surface in the list would have made the register look
arbitrary on its first day.

**Final register — 14 blocks, 5 core:**

- core: `corpus`, `ingestion`, `retrieval`, `read-api`, `label-review`
- additional: `answer`, `experts`, `mcp`, `multilingual`, `query-understanding`, `tagging`,
  `relations`, `collections`, `eval`

Names are settled and can go into config, docs and any handover vocabulary.
