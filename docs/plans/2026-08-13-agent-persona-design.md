# Agent Persona — Design Capture (2026-08-13)

**Status:** brainstorm capture, not an implementation spec. Scope held to "agents as proxy
users of AskWRI roughly as it exists today" — the product roadmap doc is set aside for this
exercise. Two of the nine "refuses" below were overruled in the session (§7) and are
reflected in the surface (§5); the rest stand as scope guards. §9 holds the impact analysis
(faster/better research at WRI) the surface must survive; it sharpened §5.5 (refusal-as-
default), §5.3 (confidence floor), refuse #2 (disposal debt), and promoted `citation_url`
from open question to load-bearing (decision log #11).

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
| 5 | "Gaps" (what WRI does not cover) is a first-class contract field and the refusal primitive | 2026-08-13 | every agent shape's gold is what we *don't* know; `coverage: poor` is the refusal signal — made structural in §5.5 (decision #10) |
| 6 | Agents read freely and *propose* writes; humans dispose via existing review queue. Agents never commit | 2026-08-13 | already the schema's rule (human tag > machine tag, always); sidesteps the "no autonomous agents" line — agent proposes, expert disposes, every disposal is a labeled judgment |
| 7 | **OVERRULED refuse #3** — conversational / multi-turn / streaming IS in scope | 2026-08-13 | user; see §7 for the bounded form (agent carries context; we stay stateless; synthesis streams) |
| 8 | **OVERRULED refuse #4** — structured extraction on our side IS in scope (on-demand, per-call) | 2026-08-13 | user; see §7; this is the overrule that grows the surface the most and departs furthest from "current capabilities" |
| 9 | All other refuses (§7) stand as scope guards | 2026-08-13 | each marks a place the surface could accrete into a platform |
| 10 | Honesty valves are **structural**, not behavioral — server returns `answer: null` on `coverage: poor`; extract returns `found: false` below a confidence floor | 2026-08-13 | §9.4: a behavioral "agent should refuse" is decorative under load; a structural refusal cannot be bypassed by a lazy/adversarial agent. Surfaces in §5.5, §5.3 |
| 11 | `citation_url` is **load-bearing** (stable, human-resolvable permalink), promoted from open question — keeping citations must be easier than stripping them | 2026-08-13 | §9.3 risk 1: the citation-stripping end-run; ergonomics, not enforcement, is the only lever. Resolves old §8.4 |
| 12 | Disposal throughput is a **measured risk**: v1 adds NO proposal-write API; "propose" = logged-as-reviewable; disposal debt is instrumented (§5.6) | 2026-08-13 | §9.3 risk 3: agents generate proposals faster than humans dispose; refuse #2 sharpened so the judgment loop compounds, not accrues. Open §8.9 |
| 13 | Reproducibility (search-trail export) is a **derivative of call logging**, not a feature | 2026-08-13 | §9.2: logged query+citation sequence is a methods-section artifact; arrives free from §5.6 |

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

Four real gaps for an agent persona:

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
4. **The contract doesn't surface document history the store has.** `documents` carries
   `status`, `created_at`, `updated_at`, `content_hash`, `extraction_confidence`, but the
   citation response returns only `doc_id`, `title`, `page`, `authors`, `year`,
   `program_series`, `relevance_tier`, `has_english_translation` — so a watcher can see a doc
   reappear or change tier but can't distinguish "re-ranked" from "re-ingested." Supersession
   and variant linking don't exist anywhere in the schema. Longitudinal uses (watcher diff,
   cite-check, living brief) need both.

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
  "answer": {                         // null unless mode=answer; ALSO null when gaps.coverage == "poor"
    "sentences": ["...", "..."],      //   (server refuses on poor coverage — see §5.5; structural, not the agent's call)
    "coverage": "good" | "limited" | "poor",  // mirrors gaps.coverage (canonical)
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
      "citation_url": "...",                              // load-bearing permalink — decision log #11
      "has_english_translation": false
    }
  ],
  "gaps": {                            // FIRST-CLASS — canonical coverage field; carries the refusal when coverage == "poor"
    "coverage": "limited",
    "weak_count": 3,
    "note": "WRI has limited published evidence on this question."
  },
  "debug": { "total_ms": 820, "cost_usd": 0.004 }
}
```

How each shape uses the one primitive:

- **Grounding plug** — `mode: answer`, reads `answer` + `citations`. The *server* refuses
  on `gaps.coverage: poor` (`answer: null` + `gaps.note`); the agent surfaces the refusal
  rather than suppresses a synthesis. Streams for lower time-to-first-token.
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

**Honesty valve (critical, load-bearing, two-part):**

1. **Quote verification (structural, cheap).** The server checks the returned `quote` is a
   literal/normalized substring of the source passage; if not, `found: false` regardless of
   LLM confidence. The cite response already marks the verbatim chunk with `**[ ... ]**`
   markers (`get_passage_with_context`, `search-service/app/main.py`), so the anchor is free.
   This catches confabulated values with a fabricated quote — the same ergonomics principle
   as refusal on poor coverage (§5.5): make the honest path structural, not behavioral. `quote`
   is load-bearing (verification + human evidence), like `citation_url` (decision log #11).
2. **Confidence floor (on the quote-verified subset).** A configurable threshold (open §8.7)
   below which the server returns `found: false` by default, so the agent does not have to
   judge. Applied only *after* quote-verify passes — confidence on an unverifiable quote is
   noise, so don't floor it. With (1) as the structural floor, `found` is the operative signal
   and `confidence` becomes advisory.

This is the overrule that departs furthest from "current capabilities" — it is new logic
(structured-output LLM call over a passage), not composition — and the biggest *faster*-
research win (screening/extraction, §9.1) depends on it, so the valve must not be
decorative. The spike (§5.3.1) tests whether the two-part valve is sufficient on
figure-heavy WRI content.

### 5.3.1 Extraction spike — the riskiest assumption

The evidence-pack's "fast" claim (§9.1) rides on extraction honesty over the content the
agent actually receives. That content is the cite response's `content` field — chunk
(400 chars, `chunk_size=400`/`overlap=80`, `search-service/app/indexing.py`) + ±150 chars
context via `get_passage_with_context`, ~550-800 chars total, with `**[chunk]**` markers —
**not** a full section, and `/api/pdf` returns the raw PDF binary (no page-text / section
fetch exists today). So extraction is bounded by chunk granularity.

**Spike question:** given the ~550-800 char `content` from figure/table-heavy WRI PDFs, can a
structured-output LLM extract a caller-specified field honestly — verifiable quote +
calibrated confidence — often enough that an evidence-pack grid isn't mostly false
negatives or confabulations?

**Method (no endpoint built):** ~20-30 WRI passages spanning the difficulty range (clean
prose / hedged value / well-parsed table cell / poorly-parsed table cell / field-absent) ×
2-3 schemas; one structured-output call each; human-label each result for correct value,
correct quote, honest `found:false`; measure precision/recall of `found`, quote-verify
catch rate, and the false-negative rate from too-short context.

**Four outcome branches:**

- **Pass** — extraction is honest, quote-verify catches confabulation, confidence is
  usable. Evidence-pack is real; proceed to plan.
- **Confabulation survives quote-verify** — the LLM copies a real substring but
  misattributes its value (extracts "12,000" from a sentence about a *different* fleet).
  Quote-verify passes, the value is wrong. Evidence-pack needs prose-only scoping or human
  confirmation (kills the "fast" claim).
- **False negatives** — the value is in the doc but not in chunk+context (table on the next
  page, column header above). The grid is emptier than reality. Fix is a section / page-text
  fetch — which doesn't exist with current capabilities. This branch means evidence-pack is
  bounded by chunk granularity until Phase 6 parsing lands.
- **Confidence uncalibrated** — the floor is on noise. With quote-verify as the structural
  floor (§5.3), `found` is the operative signal and `confidence` becomes advisory — so this
  branch is largely absorbed by the two-part valve.

**Insight that falls out before running it:** evidence-pack's value is **dimension-
dependent**. Dimensions that live in prose (geography, stated methodology, policy frame) are
extractable with current capabilities; dimensions that live in tables (cost per km, emissions
factor, fleet size) are bounded by chunk granularity and will be honestly empty often until
Phase 6 parsing lands. A researcher who wants a table-heavy grid still needs that work. This
scopes the §9.1 "fast" claim honestly: fast for prose-resident dimensions, honestly thin for
table-resident ones — not "a grid in an afternoon" for every dimension.

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
  Redis/DDB only if it bites. (Open question §8.2.)
- **No agent-management UI in v1.** Tokens issued via an admin CLI / seed step.

### 5.5 Gaps + refusal-as-default (structural, not behavioral)

`gaps` is top-level in the response (§5.1). `coverage: poor` is the **refusal primitive** —
and the refusal is **structural**: when `gaps.coverage == "poor"`, the server returns
`answer: null` + a populated `gaps.note`, *not* a synthesis the agent must choose to
suppress. The contract does not ask the agent to refuse; it makes refusal the path of least
resistance. This follows the same ergonomics principle as citations (§5.1, decision log #11):
make the honest path the easy path. A behavioral instruction ("agent *should* refuse") is
decorative under load — a lazy or adversarial agent synthesizes anyway; a structural refusal
cannot. This is one of the three load-bearing walls (§9.4).

### 5.6 Logging — the question loop, the disposal ledger, and the search trail (for free)

Every `/api/agent/*` call logs `{token_id, user_id, query, mode, cost_usd, coverage,
citations_count, ts, proposal}` to `audit_log` (exists) or a small `agent_call_log` table
(open question §8.6). Three things come out of this one stream:

1. **The question loop.** Aggregated queries → the quarterly gaps memo / research-agenda
   signal. No separate feature to build. Per-token privacy handled by governance
   (aggregate-only reporting), not by not collecting it.
2. **The disposal ledger.** `proposal` marks outputs that assert something a human should
   review (a cite-check verdict, an extracted cell, a contradiction flag). The log records
   the proposal; disposal (accept/reject/override) is recorded when it happens — so review
   *debt* is measurable before it overwhelms (refuse #2, sharpened; open §8.9). v1 does NOT
   add a proposal-write API: "propose" means "the agent's output is logged as reviewable,"
   not "the agent writes to a queue." Keeps the agent surface read-only + logging.
3. **The search trail.** A researcher's logged query+citation sequence is a methods-section-
   citeable reproducibility artifact — the H3 "search-trail export," arriving as a derivative
   of logging rather than as a feature (decision log #13).

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
| citation permalink | **load-bearing** (decision log #11) — a stable, human-resolvable `/c/<doc_id>#page=N`; scheme TBD but must resolve to the passage. Keeping citations easier than stripping them. |
| `/api/agent/*` passthrough wrappers | expose existing endpoints under the gated namespace |

Everything else is exposing + gating what already exists.

---

## 7. Refuses — scope guards (two overruled)

| # | refuse | status | consequence of overrule |
|---|---|---|---|
| 1 | No server-side agent state (no saved queries, run history, server-side diffs, schedules) | **stands** | — |
| 2 | No agent-authored writes that commit (agents read + propose; humans dispose) | **stands** | sharpened: v1 adds NO proposal-write API — "propose" = "the agent's output is logged as reviewable" (§5.6), not a queue write. Disposal debt is measured via the logging ledger (open §8.9) so the judgment loop compounds instead of accruing review debt. |
| 3 | No conversation / multi-turn / streaming | **OVERRULED** | `/api/agent/ask` accepts optional `prior_turns` (agent carries context → we stay stateless, compatible with #1) and streams synthesis in answer mode. Bounded form: we ground each turn; we do not run the conversation. This is the most "platform-y" overrule and risks the "no competing on conversation" line — kept on-side by leaving conversation to whatever model the agent already lives in. |
| 4 | No structured-metadata extraction on our side | **OVERRULED** | new `/api/agent/extract` primitive (§5.3). On-demand per-call extraction over passages, not an ingest-time metadata schema. Biggest departure from "current capabilities" (new logic, not composition). Honesty valve: `found: false` + low confidence, never invent. Note this makes evidence-pack "strains current" → "doable server-side." |
| 5 | No fake verdicts (cite-check v1 is three-verdict; superseded needs the supersession graph) | **stands** | — |
| 6 | No per-tenant corpus scoping in v1 (every token sees the full corpus) | **stands** | — |
| 7 | No separate MCP / SDK build (HTTP JSON first; an MCP shim can wrap `/api/agent/*` later) | **stands** | — |
| 8 | No score-stability guarantee (contract guarantees `doc_id` + `relevance_tier` across model swaps; disclaims raw `score`) | **stands** | makes the watcher's diff safe |
| 9 | No agent-management UI / per-agent cost dashboards in v1 (log the signals; surface aggregate later) | **stands** | — |

---

## 8. Open questions (not decided; for the implementation plan)

1. **Token issuance UX + equity** — admin CLI/seed (v1 proposal) vs a small admin page; *and*
   who gets agents (§9.3 risk 5 — benefits must not accrue only to the already-technical).
2. **Rate-limit store promotion** — in-memory per-instance → Redis/DDB. Deferred until it
   bites; flagged.
3. **Composite route vs growing `/api/answer`** — propose a *new* `/api/agent/ask` that
   composes server-side, leaving the UI-coupled `/api/answer` untouched. Confirm.
4. **~~Citation URL scheme~~ — RESOLVED** (decision log #11): a stable, human-resolvable
   permalink is load-bearing, not open. Remaining TBD is the scheme only (`/api/pdf`
   derivation vs a thin `/c/<doc_id>#page=N`).
5. **Quota granularity & cost attribution accuracy** — how precise must `cost_usd` be per
   call (embed + rerank + synthesis + extraction)?
6. **Logging table + disposal columns** — reuse `audit_log` (exists) or a dedicated
   `agent_call_log`; whether `proposal` + disposal-status are columns on the same row or a
   paired table (§5.6).
7. **Extraction confidence floor** — the threshold below which `/api/agent/extract` returns
   `found: false` by default (§5.3); applies only to the quote-verified subset (the structural
   floor is quote-verify, not confidence). How to eval/calibrate it so the valve is not
   decorative — the spike (§5.3.1) is the eval.
8. **Conversation boundary** — given overrule #3, how many `prior_turns` do we accept, and
   do we re-retrieve every turn or accept agent-supplied `citations` from prior turns?
9. **Disposal capacity vs proposal volume** — how to surface review debt (dashboard? a gate
   that throttles agent proposals when undisposed debt crosses a threshold?) before it
   overwhelms the humans whose disposal feeds the judgment loop. Includes *where* humans
   dispose of agent-type proposals — the existing review queue is shaped for human-authored
   tags, not agent verdicts at volume, so this is a deferred build we haven't budgeted.
10. **Narrow-corpus bias mitigation** — the surface is WRI-corpus-only by values (refuse: no
   open-web search); how to keep researchers reaching for the open literature where their
   frontier lives, rather than over-relying on fast internal synthesis.
11. **Document history + supersession in the contract** (§3 gap 4). The store has
   `status`/`updated_at`/`content_hash`; the citation response doesn't surface them, so
   agents can't distinguish re-rank from re-ingest. Supersession/variant linking doesn't
   exist in the schema at all. Which fields surface in v1, and does cite-check stay
   three-verdict until a supersession graph exists?

---

## 9. Impact — faster and better research at WRI

The honest frame: "faster" and "better" pull in different directions for WRI, and the
surface's contribution to each is uneven. This section is the impact analysis the surface
must survive, not a sales case for it.

### 9.1 Faster — the honest mechanism map

"Faster" is **not** mostly about search. The labor studies the vision doc cites put
searching at 15–20% of a researcher's time; screening, extraction, and drafting swallow the
rest (systematic reviews ~1,100 person-hours, mostly middle stages; a single grant proposal
100+ hours of a PI's time, "most of that reassembling what the organization already knows").

So if the agent surface only makes search faster — which is what the watcher and the
grounding plug primarily do — it has touched a fifth of the research clock. The real speed
leverage is downstream, in screening and extraction, which is *exactly* where the surface is
thinnest: it depends on `/api/agent/extract` (overrule #4), new logic, fragile on
figure-heavy PDFs, whose honesty valve (`found: false`) is the thing standing between "fast"
and "fast garbage." **The biggest time win lives in the place we're least certain works.**

Where faster is real and concrete:

- **Reassembly.** "What does WRI already know about X?" — the grant-proposal hours, the
  country-office evidence pack — becomes a function call. The composite primitive +
  extraction turn a season of reassembling into an afternoon — *with the dimension-
  dependence caveat in §5.3.1*: prose-resident dimensions (geography, stated methodology,
  policy frame) are fast; table-resident dimensions (cost per km, emissions factor, fleet
  size) are bounded by chunk granularity and honestly thin until Phase 6 parsing lands. The
  speed win the vision doc names explicitly, scoped honestly rather than overclaimed.
- **The review cycle.** Cite-checker hardens claims *before* the 4-internal/4-external review.
  Reviewers stop spending their time catching lazy errors (the superseded citation, the
  unsourced number) and spend it on substance. Compresses the long pole —
  review-revision loops — even when it doesn't touch lab-bench time.
- **Currency.** The watcher makes "current as of today" cheap: a brief or dossier
  regenerated on corpus change is a re-run + diff, not a rebuild. Faster in the sense of
  *never going stale*, which for a living literature review is the only speed that matters.

### 9.2 Better — the WRI-specific quality wins

WRI's product, per the vision, is "being right, and trustworthy." So "better research" for
WRI is not "more papers" or "faster papers" — it's *work that survives external scrutiny and
carries the logo honestly*. The agent surface's contribution to "better" sits almost entirely
on the faithfulness and judgment axes, not throughput:

- **Faithfulness as reputation protection.** The grounding plug turns the vision's enemy —
  paste into ChatGPT, get a plausible answer citing a real WRI report that says something
  else — into a channel. Every assistant that grounds in us is one less
  fluency-without-faithfulness event carrying WRI's name. Reputation-level better, and the
  single most important quality effect.
- **Gaps as the agenda.** Every shape produces "what WRI doesn't know" as exhaust —
  evidence-pack empty cells, watcher contradiction hits, cite-checker `coverage: poor`. The
  logging (§5.6) turns this into a continuous, evidence-driven map of what staff actually
  need to know, rather than a quarterly anecdote. Better-*targeted* research, a different
  kind of "better" than better-executed, and probably the highest-order effect here.
- **Judgment compounding.** Every agent-proposed verdict a researcher overrides, every claim
  an author corrects, every diff an editor rejects is a labeled judgment — and the vision
  doc's bet is that this is the asset that appreciates while models depreciate. Agents
  generate this signal at volume as a side effect of ordinary work. The flywheel only turns
  if disposal happens (§9.3 risk 3).
- **Reproducibility.** Every agent call is logged with query, mode, cost, citations. A
  researcher's search trail becomes a methods-section-citeable artifact — the H3
  "search-trail export," arriving as a byproduct of §5.6 logging rather than as a feature
  (decision log #13).
- **Cross-language coverage without language switching.** An English-asking agent surfaces
  Spanish/Chinese docs and translates the cited passage on demand. A researcher who reads
  only English stops missing the México report. Better research = not systematically blind
  to half the corpus.

### 9.3 Deep risks — where this could make research worse

1. **The citation-stripping end-run.** Once the API is open, an assistant can call us,
   strip the citations, and emit unattributed text that *came from* grounded retrieval.
   That's worse than vanilla hallucination — it carries WRI's authority without WRI's
   provenance, routed *through* us. The surface that makes correct citation easy also makes
   stripped citation possible. The contract's job is ergonomics, not enforcement: make
   keeping citations the path of least resistance (rich, stable `citation_url`,
   `relevance_tier`, `passage`). No enforcement, only ergonomics — which is why
   `citation_url` is load-bearing (decision log #11), not an open question.
2. **Confidently-wrong at higher throughput.** The agent's queries are only as good as its
   plan. A bad evidence-pack plan produces a bad grid with *real* citations — plausible,
   grounded, wrong at the cell level. `coverage: poor` and `found: false` only help if the
   agent heeds them and the researcher reads them. Without that, we've built a machine for
   producing fluent, cited, high-volume wrong work — the vision's enemy, routed through our
   corpus. This is why refusal is structural (§5.5), not behavioral.
3. **The disposal cold-start.** The vision doc names eval capacity as the binding
   constraint. Agents generate *more* proposals — cite-check verdicts, tag suggestions,
   contradiction flags, gap cells — than humans can dispose of. Refuse #2 (agents propose,
   humans dispose) is ethically right but creates a throughput problem: without scaling
   disposal, the surface generates review debt faster than it retires risk, and the
   judgment loop accrues instead of compounds. Faster proposal ≠ faster improvement. v1
   measures the debt (§5.6) and adds no proposal-write API (refuse #2 sharpened); the
   gating question is open §8.9.
4. **Narrow-corpus bias.** Everything is WRI's corpus only. A researcher who gets fast,
   well-cited answers from AskWRI may stop searching the open literature where their actual
   frontier lives. "We will not search the open web" is a values line with a research-quality
   cost: over-reliance on the institutional view, under-exposure to external contradiction.
   Faster internal synthesis can narrow the intellectual diet. Mitigation is open §8.10.
5. **Equity of access.** v1 token issuance is manual/CLI. The researchers who get agents are
   the ones who know to ask. Speed and quality benefits accrue to the already-technical,
   widening internal gaps — not a technical problem, but real, and it shapes who "faster
   research at WRI" actually means. Open §8.1.

### 9.4 What decides it

The honest synthesis: the surface's contribution to **faster** is real but bounded (it only
bites past search, in screening/extraction, where we're least sure it works); its
contribution to **better** is substantial but entirely dependent on three load-bearing
things that are easy to under-build:

1. **The honesty valves** — `gaps` first-class (§5.5), `coverage: poor` as *structural*
   refusal (§5.5), `found: false` + confidence floor (§5.3). Decorative under load; must be
   structural.
2. **Disposal capacity** — that turns proposals into compounding judgment rather than
   accruing review debt (§5.6, refuse #2, open §8.9).
3. **Citation ergonomics** — that keeping citations is easier than stripping them
   (decision log #11, `citation_url` load-bearing).

If those three hold, the surface compresses the reassembly + review stages, protects
faithfulness at scale, and turns the question loop into a continuous research-agenda signal.
If any one slips, we've built a high-throughput machine for confidently-cited work that
*looks* like better research and isn't. The design's refuses (#2 propose-don't-commit, #5
no-fake-verdicts, #8 no-score-stability-guarantee) and §5.5 (gaps + refusal-as-default) are
not polish — they are the three load-bearing walls. The overrules (#3 conversation, #4
extraction) are precisely the two places that trade safety for capability, which is why they
were flagged as the platform-risk ones during the brainstorm.

---

## 10. Explicitly out of scope for this artifact

- The product-roadmap features (dossiers, standing briefs, cite-check product, "What WRI
  Says" UI, methods index, Expertise@WRI, supersession graph) — set aside per the exercise.
  Several of this surface's primitives are the *agent-shaped substrate* those features
  imply, but the decision to build the features is separate.
- Autonomous research agents beyond the corpus, foundation-model training, open-web search,
  partner/external-agent rings (shape D) — all out of scope; shape D is a later ring.

This artifact is a design capture of the brainstorm. It is deliberately not an
implementation plan; the next step (if pursued) is a writing-plans pass over §5–§8,
constrained by the three load-bearing walls in §9.4.
