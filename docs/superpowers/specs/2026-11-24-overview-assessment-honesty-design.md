# Overview: honest assessment state and tier-consistent counts — Design

- **Date:** 2026-11-24
- **Issue:** [wri/askwri#498](https://github.com/wri/askwri/issues/498) — Section A, items 1 and 2
- **Status:** Approved design; implementation plan to follow
- **Branch:** `fix/overview-provenance-tiers` (PR targets `qa`)
- **Scope:** small change. Items 3–5 of Section A, and sections B–D, are out of scope.

## Problem

Two defects in the cite-mode Overview, both visible to a user of the Cite-mode
technical note's screenshots.

**1. A canned rating is shown as if a model wrote it.** `POST /api/alignment`
answers `200 ok: true` on every failure path, with a canned assessment
(`alignment: 'Moderate'` for the deterministic and exception paths, `'Low'` when
`OPENAI_API_KEY` is unset) and marks it `provenance.produced: false` with a
`fallback_reason`. `src/app/results/page.tsx` (`runAlignment`, ~L409-524) reads
only `j.assessment.insights` / `.alignment` and never looks at `provenance`, so
the Overview renders a rating and a bullet no model wrote. The route's comment
already says `produced: false` exists for exactly this purpose; no client reads
it.

**2. The Overview's relevance bands disagree with the tiers on screen.**
`buildAlignmentSummary` (`src/app/utils/utils.tsx` ~L322-380) counts "highly
relevant" as `score >= 0.8` and "moderately relevant" as `0.5 <= score < 0.8`.
The tiers are set by the search service from `cite_strong_threshold = 0.70` and
`cite_partial_threshold = 0.30` (`search-service/app/config.py` L280-281, applied
in `app/main.py` ~L1847-1857). A result list that the user sees as several
Strong rows can be summarised to the model as "Highly relevant: 0".

## Findings that update the issue text

1. **The tier is already on every document.** `DocMeta.relevance_tier`
   (`src/lib/llamacloud.ts:24`) is threaded through `/api/llamaindex`
   (`route.ts:209`) and is what `CitePanel` renders (`tierLabels`). So item 2
   needs no threshold constants in TypeScript — only counting. Importing
   `0.70/0.30` into the app would create the second copy that this item exists
   to eliminate.
2. **Not every document has a tier.** The search service omits
   `relevance_tier` whenever the reranker did not run (`rerank=false`
   diagnostics, reranker-outage fallback; `main.py` ~L1841-1862). Today's score
   bands silently count those documents off a score that is not a rerank score.
3. **"Hide the Overview" is not free.** `src/app/components/results/index.tsx`
   (~L167) renders a **spinner** whenever `alignLoading || !alignment ||
   !alignment.insights?.length`. With no assessment and no loading, it spins
   forever — so any hidden/unavailable state must be an explicit branch, not an
   absence.
4. **Answer mode has no insights area.** `AnswerPanel.tsx` (~L283-296) renders
   only the `Alignment: X` badge; the insights `AIResearchModal.tsx` fetches are
   never displayed. The two surfaces therefore need different treatment.
5. **The cite page caches the assessment per query** (`queryCache`, 5-minute
   TTL; read at ~L208-231 and ~L533-537). Caching a failure would replay a
   transient upstream error on a repeat query.

## Goals

- A failed assessment never presents a rating or a bullet as model output.
- The Overview's counts use the same tiers, and therefore the same thresholds,
  as the results table.
- No new threshold constant anywhere in TypeScript.

## Non-goals

- Evaluating the Overview (issue item 4), or changing its prompt, model, or
  token budget.
- Improving what the Overview knows about the corpus (item 3).
- Renaming "Overview" / "Alignment" (item 5).
- Any change to the `/api/alignment` response contract, its `provenance`
  fields, or its failure behaviour.

## Anti-goals

- A fix that leaves the user unable to distinguish "no assessment" from "no
  such section" (the reason item 1 offers hiding *or* an explicit message).
- A fix that makes a genuinely produced assessment disappear because some
  unrelated branch set a flag.
- Re-deriving `0.70/0.30` in the app, by copy or by a second config source.

## Approaches considered

**Where the unavailable state lives.**

- *(i) Reason beside the assessment — chosen.* `alignment` keeps its meaning
  ("an assessment exists"); a separate `alignFailed` flag carries the failure.
  Render becomes a three-way: loading → spinner, failed → message, assessment →
  insights + badge. Touches two files, adds one state hook, changes no shared
  type.
- *(ii) A union `Assessment` type.* One state, discriminated at each consumer.
  Rejected: `Assessment` is shared by `AnswerPanel`, `CitePanel` prop types and
  both pages, so every consumer pays a narrowing for two screens of UI.

**How the counts are derived.**

- *Count `relevance_tier` — chosen.* The tiers arrive with the documents; the
  untiered remainder is reported as its own count.
- *Share a `0.70/0.30` constant between app and search service.* Rejected:
  recreates the drift the item is about, across two languages.
- *Drop the counts from the prompt.* Rejected: it changes what the model sees
  with no evaluation to measure it against (item 4 is out of scope).

## Decisions

Settled with the operator during design:

1. **Explicit message, not a hidden section.** When the assessment was not
   produced, the Overview heading stays and its body renders one
   `InlineMessage` line (the component the page already uses for the off-topic
   warning): *"Assessment unavailable — the assessment service didn't respond
   for this search. The results below are unaffected."* No badge.
2. **One line for every cause.** `fallback_reason` values (`upstream_500`,
   `parse_error`, `no_api_key`, `error`, `no_text`, `model_override_rejected`)
   are diagnostics and stay in `debug`; none of them becomes user copy.
3. **`sanitized: true` is left visible as it is today.** The flag conflates two
   different things — insights replaced by the canned "Unable to assess
   alignment" bullet, and a rating coerced from e.g. `Medium` to `Moderate`.
   The second is the model's own value canonicalised, and gating on the flag
   would hide a good assessment; splitting the flag is a route-contract change
   that this issue does not ask for. Recorded as a `shortcut:` comment pointing
   at #498.
4. **Answer mode renders nothing when unavailable.** Its only alignment surface
   is the badge, so the fix there is to treat `produced === false` as "no
   assessment" — which the component already renders as nothing.
5. **A failed assessment is not cached, and not retried by itself.** The query
   cache entry keeps its docs; its `alignment` stays unset so a repeat query
   retries. The auto-run effect gates on `!alignFailed`, so one failure is one
   failure — measured today: a failing route is called once, and that is what
   keeps the message stable on screen instead of flickering against retries.
6. **Counts, not bands.** The summary line becomes
   `Strong: N. Partial: M. Weak: K.` plus `Untiered: J.` only when J > 0.

## The change, file by file

- `src/app/utils/utils.tsx` — `buildAlignmentSummary`: replace the two score
  filters with counts of `relevance_tier`, add the conditional untiered count,
  and update the docstring's line reference to the search service's thresholds.
- `src/app/results/page.tsx` — `alignFailed` state; set it (with
  `setAlignment(null)`) on a non-ok response, `produced === false`, a thrown
  fetch, and the empty-docs early return; clear it wherever a new search or a
  new run resets `alignment`; gate the auto-run effect on `!alignFailed`; never
  write `alignment` into `queryCache` when failed; pass the flag to
  `CitePanel`.
- `src/app/results/CitePanel.tsx` — accept `alignFailed` and pass it on.
- `src/app/components/results/types.ts` — `ResultsPageProps.alignFailed?`.
- `src/app/components/results/index.tsx` — the three-way render; the message
  line lives here, next to the heading it belongs to.
- `src/app/components/AnswerMode/AIResearchModal.tsx` — one condition: treat
  `provenance.produced === false` like a failed response (leaves the badge
  empty via the existing `else`).
- Tests:
  - new `src/__tests__/alignment-summary.test.ts` — tier counts, the untiered
    clause present and absent.
  - `src/app/components/results/__tests__/ResultsPage.test.tsx` — the message
    renders and the badge does not, when `alignFailed` is set.
  - `src/__tests__/results-page.test.tsx` — the page sets the flag when
    `/api/alignment` answers `produced: false`, clears it when a model did
    produce the assessment, and does not re-call a failed route (the suite
    stubs `CitePanel`, so this is where the call site is observable).
  - `evaluation/__tests__/route-sweep-payloads.test.ts` — the asserted summary
    prefix moves to the new wording; the fixture gains tiers so the counts are
    non-trivial.

## Left to the builder

- Exact wording of the unavailable line, within decision 1's meaning.
- Whether the message sits inside the `Box` that holds the insights or below
  the heading — visual detail, no behaviour.
- Where in `runAlignment` each reset belongs, driven by the existing
  `setAlignment(null)` call sites.

## Verification

- `npx jest` — whole suite green (baseline at branch start: 106 suites / 1322
  tests passing, 22 DB suites skipped).
- `npx prettier --check` and `npx eslint` on the touched files.
- Manual: with `OPENAI_API_KEY` unset (or by stubbing a 500), load a cite-mode
  query and confirm the Overview shows the unavailable line, no badge, and that
  re-running the same query retries instead of replaying the failure.
