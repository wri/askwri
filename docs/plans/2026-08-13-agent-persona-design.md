# Agent Persona — Design Capture (2026-08-13)

**Status:** brainstorm capture, not an implementation spec. Scope held to "agents as proxy
users of AskWRI roughly as it exists today" — the product roadmap doc is set aside for this
exercise. Two of the nine "refuses" below were overruled in the session (§7) and are
reflected in the surface (§5); the rest stand as scope guards.

**Problem:** what would it mean to design AskWRI for a new persona — agents acting on behalf
of WRI researchers? How would they use us, what would they want to do/see, what new use cases
open up, and how do we make it easy — without turning AskWRI into a platform.

Filed in `docs/plans/` to match repo convention (every prior design doc lives here), not the
`docs/superpowers/specs/` default.

---

## 1. Decision log

| # | decision | when | why |
|---|---|---|---|
| 1 | Hold all four agent shapes open; lean A (researcher-delegated) / B (grounding plug) where it sharpens | 2026-08-13 | user; A/B are lowest-friction, C/D are higher-stakes and partly off the vision's stated non-goals |
| 2 | Scope to *current* AskWRI capabilities — set the roadmap doc aside | 2026-08-13 | user; isolate the agent-persona question from already-planned work |
| 3 | The MVP agent surface is one composite primitive + token gating over *existing* endpoints, not a new subsystem | 2026-08-13 | §3 finding: AskWRI is already most of an agent-callable API; the two-step is the universal friction |
| 4 | `relevance_tier` (strong/partial/weak) and `coverage` (good/limited/poor) are first-class contract fields, not debug noise | 2026-08-13 | they are the agent's judgment primitives (answer/refuse/diff); already golden-set-calibrated |
| 5 | "Gaps" (what WRI does not cover) is a first-class contract field and the refusal primitive | 2026-08-13 | every agent shape's gold is what we *don't* know; `coverage: poor` is the documented refusal signal |
| 6 | Agents read freely and *propose* writes; humans dispose via existing review queue. Agents never commit | 2026-08-13 | already the schema's rule (human tag > machine tag, always); sidesteps the "no autonomous agents" line — agent proposes, expert disposes, every disposal is a labeled judgment |
| 7 | **OVERRULED refuse #3** — conversational / multi-turn / streaming IS in scope | 2026-08-13 | user; see §7 for the bounded form (agent carries context; we stay stateless; synthesis streams) |
| 8 | **OVERRULED refuse #4** — structured extraction on our side IS in scope (on-demand, per-call) | 2026-08-13 | user; see §7; this is the overrule that grows the surface the most and departs furthest from "current capabilities" |
| 9 | All other refuses (§7) stand as scope guards | 2026-08-13 | each marks a place the surface could accrete into a platform |

---

## 2. The four agent shapes (held open; A/B leaned into)

| shape | autonomy | principal | what it does | where it strains current capabilities |
|---|---|---|---|---|
| **B. Grounding plug** | general assistant calls us as a tool | researcher (via their assistant) | assistant answers a WRI question with our citations; researcher may never see our UI | attribution/citation-stripping risk; the two-step |
| **A. Watcher** | low; schedule + diff + notify | researcher | re-runs a standing question, diffs by `doc_id`+`relevance_tier`, notifies on corpus change | rate limits (first place they bite); query must be stable to be diffable |
| **A. Cite-checker** | low; read-only | researcher | pastes a draft, checks every claim → supported / contradicted / uncited-but-citable | supersession verdict needs a graph that does not exist → v1 is three-verdict, said honestly |
| **A. Evidence-pack builder** | medium; runs many queries, assembles a grid | researcher | topic + dimensions → {dimension × document} grid with a quote per cell | structured metadata is thin; 50–200 calls (cost); **mitigated by overrule #8 — extraction on our side** |

Full per-shape notes (do/want/see/strain/new use cases) live in the session transcript; this
table is the capture. New use cases that fell out of each:

- **B:** "What does WRI say about X" as a callable function for any internal tool (Comms,
  country office, policy lead) — institutional voice as an API; multilingual grounding for
  free via `/api/translate`; the question loop as automatic exhaust.
- **A (watcher):** contradiction watch (the corpus watching itself for evidence *against* a
  position); country-office publication watch; pre-submission draft watch (a researcher's
  own draft monitored against corpus shifts).
- **A (cite-checker):** fact-check-a-sentence for Comms; grant-proposal verification;
  missed-citation surfacing (the inverse of cite-check — a writing aid, not just a gate).
- **A (evidence-pack):** rapid evidence pack for a country office; comparative methods table
  on demand (methods-index *extracted at query time*, a pilot for whether a real index is
  worth building); gap mapping as a byproduct (every empty cell is a research gap).

---

## 3. Current-state finding — AskWRI is already most of an agent-callable API

The read endpoints are unauthenticated and return structured JSON today:
`/api/llamaindex` (retrieve: `doc_id`, `title`, passage `content`, `page`, `score`,
`relevance_tier` strong/partial/weak, `authors`, `year`, `program_series`,
`has_english_translation`), `/api/answer` (synthesis `sentences[]` + `coverage` good/limited/
poor + `low_coverage` warning + per-source `relevance_tier`), `/api/relates` + `/api/batch-relates`
(one-line relation per doc, `relation: direct|indirect`), `/api/why`, `/api/translate`
(on-demand English of a passage), `/api/alignment` (claim-vs-passage alignment
`High|Moderate|Low|Very Low`), `/api/catalog`.

Three real gaps for an agent persona, and only three:

1. **The two-step.** `/api/answer` is UI-coupled — it takes `{query, docs}` where `docs` are
   pre-fetched by the React client. An agent must do retrieve-then-synthesize itself. There
   is no "ask this question, get a grounded answer + citations" primitive. **Universal
   friction across all four shapes.**
2. **No programmatic identity, quota, or rate limit.** Reads are open to anyone who can reach
   the origin; writes (tags, collections, flags) are behind a human JWT session an agent
   cannot honestly hold.
3. **No extraction primitive** (post-overrule #8 — see §7). Geography / fleet size / cost-km
   live in passages, not metadata. Evidence-pack extraction was fragile-agent-side; the
   overrule moves it server-side.

Everything else an agent might *do* is composition over what's there.

---

## 4. Cross-cutting findings (true of every shape)

1. **The two-step is the universal friction.** Collapsing `/api/llamaindex` + `/api/answer`
   into one primitive serves all four. Cheapest, highest-leverage ease change.
2. **Tiers + coverage are the agent's judgment primitives.** Already golden-set-calibrated;
   exactly what an agent needs to decide answer / refuse / flag / diff. Treat as first-class
   contract, not debug noise.
3. **Identity + quota is the universal prerequisite.** All four need a token — to attribute,
   rate-limit, collect the question loop, size cost. The one piece of infra none can skip.
4. **The gold is what we don't know.** Poor-coverage questions, empty dossier cells,
   contradictions, unsupported claims — all exhaust. The question loop / research-agenda
   input, made automatic by agents rather than a feature we build. Free if we log it.
5. **Read freely, propose writes — humans dispose.** The agent is the proposer; the expert is
   the disposer; every disposal is a labeled judgment feeding the loop. Already the schema's
   rule; agents generalize it.
6. **"What WRI Says" wants to be an API before it's a UI.** Comms, policy, country offices all
   reduce to "give me WRI's current position on X with provenance." Natural home is a function
   call.

---

## 5. The MVP agent surface

### 5.1 The one composite primitive

```
POST /api/agent/ask
Authorization: Bearer <token>
{
  "query": "compact urban growth in India 2019–2026",
  "mode": "cite" | "answer",          // default: cite (raw, cheap, diffable)
  "max_results": 20,
  "min_year": 2019, "max_year": 2026,
  "required_program": "World Resources Report",
  "prior_turns": [                    // OPTIONAL — agent carries context; we stay stateless
    {"role": "user", "query": "..."},
    {"role": "assistant", "answer": "...", "citations": [...]}
  ],
  "stream": false,                    // OPTIONAL — answer mode may stream synthesis (SSE)
  "include_relates": false            // OPTIONAL — adds the one-line "why" per citation
}
```

Response (extends existing shapes — does not invent a new schema):

```
{
  "query": "...",
  "mode": "cite",
  "answer": {                         // null unless mode=answer
    "sentences": ["...", "..."],
    "coverage": "good" | "limited" | "poor",
    "warning": "low_coverage" | null
  },
  "citations": [                       // always present — the grounded evidence
    {
      "doc_id": "...", "title": "...",
      "authors": ["..."], "year": 2024, "program_series": "...",
      "page": 12, "passage": "...",
      "relevance_tier": "strong" | "partial" | "weak",   // golden-set-calibrated
      "relation": "direct" | "indirect",                 // from /api/relates; present only if include_relates
      "relates": "...",                                   // one-line why; present only if include_relates
      "citation_url": "...",                              // see open question §8
      "has_english_translation": false
    }
  ],
  "gaps": {                            // FIRST-CLASS — not debug noise
    "coverage": "limited",
    "weak_count": 3,
    "note": "WRI has limited published evidence on this question."
  },
  "debug": { "total_ms": 820, "cost_usd": 0.004 }
}
```

How each shape uses the one primitive:

- **Grounding plug** — `mode: answer`, reads `answer` + `citations`, refuses on
  `gaps.coverage: poor`. Streams for lower time-to-first-token.
- **Watcher** — `mode: cite`, diffs `citations` by `doc_id` + `relevance_tier` across runs
  (raw `score` explicitly *not* guaranteed stable across model swaps — see refuse §7 #8).
- **Cite-checker** — `mode: cite` per claim, then `/api/agent/alignment` (already exists) for
  the verdict.
- **Evidence-pack** — `mode: cite` × many, then `/api/agent/extract` (§5.3) per cell; fetch
  `/api/agent/pdf/[doc_id]` for more context.

### 5.2 Granular endpoints — exposed + gated, no logic changes

`/api/agent/relates` (→ batch-relates), `/api/agent/alignment`, `/api/agent/translate`,
`/api/agent/pdf/[doc_id]`, `/api/agent/catalog`. Same bodies, same responses, gated by the
token. Agents that want to drive stages themselves (cite-checker, evidence-pack) call these
directly.

### 5.3 Extraction primitive (from overrule #8)

```
POST /api/agent/extract
Authorization: Bearer <token>
{
  "source": {"doc_id": "...", "page": 12} | {"passage": "..."},
  "schema": [
    {"field": "geography",   "type": "string",  "instructions": "country / region / city"},
    {"field": "fleet_size",  "type": "integer", "unit": "vehicles"},
    {"field": "cost_per_km", "type": "number",  "unit": "USD"}
  ],
  "max_context_chars": 4000
}
```

Response:

```
{
  "fields": [
    {"field": "geography",  "value": "Bogotá, Colombia", "quote": "...", "page": 12,
     "found": true,  "confidence": 0.9},
    {"field": "cost_per_km", "value": null,               "quote": null,  "page": null,
     "found": false, "confidence": 0.0}
  ],
  "source": {"doc_id": "...", "page": 12}
}
```

**Honesty valve (critical):** extraction returns `found: false` + low `confidence` rather
than inventing a value. The vision doc flags figure/table-heavy PDFs as hard to parse;
extraction confidence must be surfaced so the agent can decide to leave a cell empty (a
labeled gap) rather than fill it with a guess. This is the overrule that departs furthest
from "current capabilities" — it is new logic (structured-output LLM call over a passage),
not composition.

### 5.4 Token + quota — thinnest possible

- Reuse the existing `users` table. New `api_tokens` table:
  `{id, user_id, label, token_hash, created_at, revoked_at}`. A token maps to a human
  principal — an agent acts *as* a researcher. The "proxy user" model made literal.
- **Auth:** `Authorization: Bearer <token>` → `verifyAgentToken` (mirrors the existing
  `verifySession` in `src/lib/auth/session.ts`). One small middleware on `/api/agent/*`.
- **Quota:** per-token `{requests_per_minute, daily_cost_usd_budget}`. Enforce both. Return
  `X-Quota-Remaining-Calls` / `X-Quota-Remaining-Cost` headers so the agent backs off itself.
- **Rate-limit store:** in-memory per-instance for MVP (same pattern the login route already
  uses, with the same "acceptable for internal tool" caveat). Flag it; promote to
  Redis/DDB only if it bites. (Open question §8.)
- **No agent-management UI in v1.** Tokens issued via an admin CLI / seed step.

### 5.5 Gaps as a first-class contract field

`gaps` is top-level in the response (§5.1). `coverage: poor` is the **refusal primitive** —
the contract documents that an agent *should* answer "WRI has little/no published evidence on
this" rather than synthesize. This is the one behavioral instruction embedded in the contract,
because it is the whole point.

### 5.6 Logging — the question loop, for free

Every `/api/agent/*` call logs `{token_id, user_id, query, mode, cost_usd, coverage,
citations_count, ts}` to `audit_log` (exists) or a small `agent_call_log` table (open
question §8). This *is* the question loop — no separate feature to build. Aggregate later
for the quarterly gaps memo. Per-token privacy handled by governance (aggregate-only
reporting), not by not collecting it.

---

## 6. Genuinely new code (all small)

| piece | what |
|---|---|
| `/api/agent/ask` route | composes retrieve + synthesize server-side; supports `prior_turns` (agent-carried context) and `stream` (SSE in answer mode) |
| `/api/agent/extract` route | structured-output LLM call over a passage with a caller-supplied schema; returns `found`/`confidence` per field |
| `verifyAgentToken` + middleware | mirrors `verifySession`; gates `/api/agent/*` |
| `api_tokens` table + seed/CLI | token issuance + revocation, mapped to `users` |
| `agent_call_log` (or `audit_log` rows) | the question loop, automatically |
| `gaps` lifted to first-class | contract field on `/api/agent/ask` |
| citation permalink | small — derive from existing `/api/pdf` route, or build a thin `/c/<doc_id>#page=N` (open §8.4) |
| `/api/agent/*` passthrough wrappers | expose existing endpoints under the gated namespace |

Everything else is exposing + gating what already exists.

---

## 7. Refuses — scope guards (two overruled)

| # | refuse | status | consequence of overrule |
|---|---|---|---|
| 1 | No server-side agent state (no saved queries, run history, server-side diffs, schedules) | **stands** | — |
| 2 | No agent-authored writes that commit (agents read + propose; humans dispose) | **stands** | — |
| 3 | No conversation / multi-turn / streaming | **OVERRULED** | `/api/agent/ask` accepts optional `prior_turns` (agent carries context → we stay stateless, compatible with #1) and streams synthesis in answer mode. Bounded form: we ground each turn; we do not run the conversation. This is the most "platform-y" overrule and risks the "no competing on conversation" line — kept on-side by leaving conversation to whatever model the agent already lives in. |
| 4 | No structured-metadata extraction on our side | **OVERRULED** | new `/api/agent/extract` primitive (§5.3). On-demand per-call extraction over passages, not an ingest-time metadata schema. Biggest departure from "current capabilities" (new logic, not composition). Honesty valve: `found: false` + low confidence, never invent. Note this makes evidence-pack "strains current" → "doable server-side." |
| 5 | No fake verdicts (cite-check v1 is three-verdict; superseded needs the supersession graph) | **stands** | — |
| 6 | No per-tenant corpus scoping in v1 (every token sees the full corpus) | **stands** | — |
| 7 | No separate MCP / SDK build (HTTP JSON first; an MCP shim can wrap `/api/agent/*` later) | **stands** | — |
| 8 | No score-stability guarantee (contract guarantees `doc_id` + `relevance_tier` across model swaps; disclaims raw `score`) | **stands** | makes the watcher's diff safe |
| 9 | No agent-management UI / per-agent cost dashboards in v1 (log the signals; surface aggregate later) | **stands** | — |

---

## 8. Open questions (not decided; for the implementation plan)

1. **Token issuance UX** — admin CLI/seed (v1 proposal) vs a small admin page. Deferred.
2. **Rate-limit store promotion** — in-memory per-instance → Redis/DDB. Deferred until it
   bites; flagged.
3. **Composite route vs growing `/api/answer`** — propose a *new* `/api/agent/ask` that
   composes server-side, leaving the UI-coupled `/api/answer` untouched. Confirm.
4. **Citation URL scheme** — no `/c/` permalink route exists today. Derive from the existing
   `/api/pdf/[filename]` route, or build a thin human-facing `/c/<doc_id>#page=N`. Small.
5. **Quota granularity & cost attribution accuracy** — how precise must `cost_usd` be per
   call (embed + rerank + synthesis + extraction)?
6. **Logging table** — reuse `audit_log` (exists) or a dedicated `agent_call_log`. Question
   loop aggregation shape.
7. **Extraction confidence calibration** — threshold below which `/api/agent/extract` should
   refuse and return `found: false` outright; how to eval it.
8. **Conversation boundary** — given overrule #3, how many `prior_turns` do we accept, and
   do we re-retrieve every turn or accept agent-supplied `citations` from prior turns?

---

## 9. Explicitly out of scope for this artifact

- The product-roadmap features (dossiers, standing briefs, cite-check product, "What WRI
  Says" UI, methods index, Expertise@WRI, supersession graph) — set aside per the exercise.
  Several of this surface's primitives are the *agent-shaped substrate* those features
  imply, but the decision to build the features is separate.
- Autonomous research agents beyond the corpus, foundation-model training, open-web search,
  partner/external-agent rings (shape D) — all out of scope; shape D is a later ring.

This artifact is a design capture of the brainstorm. It is deliberately not an
implementation plan; the next step (if pursued) is a writing-plans pass over §5–§8.
