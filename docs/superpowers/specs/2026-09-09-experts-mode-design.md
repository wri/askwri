# Experts mode (`/experts`) — Design

- **Status:** approved design, prototype scope. Weights and thresholds below are starting
  points to be tuned against labeled queries, not final values.
- **Mockup:** [`2026-09-09-experts-mode-mockup.html`](./2026-09-09-experts-mode-mockup.html)
  (static, self-contained; open in a browser). Live copy:
  https://claude.ai/code/artifact/2525bc21-91d1-439f-a362-5f749f358241
- **Related:** product vision "Expertise@WRI" (`docs/AskWRI-Product-Vision-2026-2028.docx`,
  H2 2027 internal v1); issue [#411](https://github.com/wri/askwri/issues/411) author-name
  formats; issue #323 topic taxonomy; issue #324 author normalization.
- **Base branch:** `qa`.

## 1. Goal

An unlisted standalone page where a WRI staff member types a question or topic and gets
back the people at WRI whose published work is closest to it, ranked with visible
evidence, plus a graph showing where each person sits in topic space relative to the
others. It is the first probe of the vision doc's Expertise@WRI: "surface the right expert
on any topic," and "when the corpus is silent, still say these three people are closest."

Three users, from the vision doc: a researcher looking for a co-author, a comms officer
looking for a quotable scientist, a country office looking for the person who built a
model.

## 2. What exists (survey, QA on 2026-09-09)

| Signal | Count | Notes |
|---|---|---|
| Searchable documents | 201 | all Cities program |
| Distinct author strings | 582 | 907 author–document links; `documents.authors` is a `; `-separated string, no people entity |
| Topic tags | 757 | 958 `tag_embeddings` (cohere-embed-v4), 194 with a parent, 109 aliases, ~5.5 accepted topics per doc |
| Geography tags | 201 | 212 links on 159 docs |
| Office tags | 9 | plus `documents.wri_primary_office` with spelling drift |

Reusable machinery, none of which changes: hybrid `/query` with `relevance_tier`;
query→tag cosine (`search-service/app/topic_sense.py`, facet-parameterized);
`document_tags` with human-override precedence; query understanding (`core_topic`,
`likely_off_topic`, suggestions); the design-system components already used by the
research UI (`Navbar`, `Tag`, `Table`, `Textarea`, `Button`, `InterpretationLine`,
`EmptyStateTopics`, `DocumentPreviewModal`, `QuerySuggestions`).

Two data facts that shaped the design:

- **Hub topics.** "Transport decarbonization" is on 145 of 201 searchable docs. It is
  a CSV-seeded program label (`source='external'`, confidence 1.0), not an LLM topic;
  every other top topic is `llm` with df ≤ 45. Any tag-based signal that ignores topic
  frequency connects everyone to everyone. Every use of a topic in this design is
  weighted by specificity `ln(N / df)`.
- **Split author identities.** 122 author entries on 30 docs are stored `Given Family`
  (CSV-imported rows) while worker-extracted rows store `Family, Given`; 25 people appear
  under two spellings (#411). Aggregation must group on a normalized key.
- **Translations are separate rows.** 11 confirmed `translation_of` pairs are both
  `searchable` on QA and 9 share identical author strings. `translation_pairs_enabled`
  is off, so `/query` returns original and translation as separate hits. Every count in
  this design is over *works* (an original plus its confirmed translations), never rows.
- **`/query` is a top-25 slice, not the corpus.** `CITE_PRESET.maxResults` is 25
  (`src/config/retrieval.ts`), and the reranker scores at most 100 chunks with 2 per doc
  (`rerank_candidates`, `cite_rerank_per_doc_cap`), so at most about 50–100 docs can
  carry a tier per query. The evidence term must ask for more than the UI preset does,
  and the reranker window is a stated ceiling.

Premise check (2026-09-09, adversarial agent) findings are folded into the sections
below; the review notes are in §13.

## 3. Architecture

Option A from the brainstorm: app-tier aggregation.

| Component | Where | Owner |
|---|---|---|
| Page | `src/app/experts/page.tsx` + `src/app/components/Experts/*` | app |
| API route | `src/app/api/experts/route.ts` | app |
| Evidence joins | `src/db/queries/expertsEvidence.ts` | app (read-only over `documents`, `document_tags`, `tags`) |
| Ranking (pure) | `src/lib/experts/rank.ts`, `authorKey.ts`, `peers.ts`, `layout.ts` | app |
| Query log | `experts_mode_query_logs` table + `src/db/queries/insertExpertsModeQueryLog.ts` | app |
| Tag lookup | `POST /tags/nearby` in `search-service/app/routers/tags.py` | python, additive |

The `/query` request/response contract is untouched. `/tags/nearby` is a thin wrapper
over the existing `nearby_tags()` and reuses the cached query embedding.

**Sequence** for one request: the route calls the search service `/query` directly
(cite preset fields, but `max_results: 200` so the evidence term sees every doc that
cleared the logit floor, not the UI's top 25), then `/tags/nearby` (sequential, so the
second call hits the query-embedding LRU cache rather than racing it), then one SQL
round trip loads authors, office, year, doc type, accepted topic/geography tags, and
confirmed translation relations for every candidate document; then `rank()` runs.
Expected latency: cite mode plus roughly 150 ms. Known ceiling: the reranker window is
100 chunks at 2 per doc, so `D` can never exceed about 100 docs regardless of
`max_results`; the spec states this rather than pretending `D` is the corpus.

**Why not the alternatives.** A search-service-native `/experts` is viable: the Python
service already reads `documents`, `document_tags`, and `tags` on the query path
(`topic_retrieval.py`, `main.py` corpus-match), and it would remove the second endpoint
and the cache ordering concern. App-tier aggregation is a preference, chosen so the
ranking is a pure TypeScript module next to the UI that consumes it and testable
without the search service. Precomputed author vectors would be fastest but rank people
on something other than the documents that actually matched; that is a candidate later
signal, not the MVP.

## 4. Ranking

### 4.1 Inputs

- **Work**: a searchable doc plus its confirmed translations
  (`document_relations` with `status='confirmed'`, `relation_type='translation_of'`).
  Every set and count below is over works; a work's authors are the union of its rows'
  authors (keyed per §6), its office and year come from the original, its tags are the
  union. `/query` hits on either row collapse to the work with the best tier.
- `D`: works from `/query` with `relevance_tier ∈ {strong, partial, weak}` and rank.
- `T_topic`: top 10 topic tags by cosine, floor 0.30 (`topic_sense_min_cosine`).
  `T_geo`: top 3 geography tags, same floor.
- For each candidate work: authors in stored order, `wri_primary_office` (normalized on
  read: `WRI México` → `WRI Mexico`), `year_published`, `article_type`, accepted topic
  tags, accepted geography tags. Authors always come from `documents.authors`, never
  from `/query` chunk metadata (that field is the raw CSV value and is truncated to 100
  characters at embed time).
- `N`: count of searchable works; `df(t)`: searchable works with accepted tag `t`.
  Computed by extending the accepted-count query in `tagsAdmin.listTagsWithCounts` with
  the `status='searchable'` filter and the work collapse, not by a new query shape.
- Tag confidence is loaded but **not** used in `S(p)`; accepted tags count 1. The
  retrieval tag lane weights by confidence; this design does not, because accepted
  confidences on QA span only 0.72–1.0 and the specificity term carries far more signal.

### 4.2 Candidates

People (section 6) who authored any doc in `D`, plus people who authored any searchable
doc carrying a tag in `T_topic`. Cap at 300 candidates by taking `D` first, then
tagged docs in descending cosine of their best matched topic.

### 4.3 Score

```
E(p) = Σ_{d ∈ D, p authored d}  tier_w(d) · pos_w(d, p) · rec_w(d)
S(p) = Σ_{t ∈ T_topic}  cos(q, t) · spec(t) · min(n_p(t), 3) / 3
score(p) = 0.7 · E(p)/max E  +  0.3 · S(p)/max S
```

| Factor | Values |
|---|---|
| `tier_w` | strong 1.0 · partial 0.5 · weak 0.15 |
| `pos_w` | `1 / (1 + 0.3 · i)`, `i` = 0-based author index among people (organizations skipped) |
| `rec_w` | year ≥ current−3 → 1.0 · ≥ current−7 → 0.85 · older or null → 0.7 |
| `spec(t)` | `ln(N / max(df(t), 1))` |
| `n_p(t)` | searchable docs by `p` with accepted tag `t` |

Geography matches (`T_geo`) do not enter the score in v1; they are shown as chips and
in the evidence panel. Adding them as a third term is a follow-up once the topic term
is judged.

Prolific authors are not down-weighted: prolific and relevant is the expert signal.
The evidence panel shows concentration ("5 of 27 documents match") so the reader can
judge it.

### 4.4 Silent corpus

If `D` is empty or `/query` returns `likely_off_topic: true`, `score = S/max S` and the
response sets `mode: "topic_only"`. The page shows the banner "No direct matches for
‹query›. These people are closest by topic." If `T_topic` is also empty, the response
carries no people and the page shows the nothing-at-all state with nearby-topic chips
from `understanding.suggestions`.

`likely_off_topic` is only ever set when the LLM understanding sidecar produced a
`core_topic` (`QUERY_UNDERSTANDING_LLM_ENABLED`, on for QA, off for production), and it
is a vocabulary-coverage heuristic, not a retrieval-quality measure. On production the
`topic_only` branch therefore triggers only on empty `D`. The spec accepts that; the
banner copy must not claim more than "no direct matches."

### 4.5 Peers

For ranked people `p, q`:

```
shared(p, q) = Σ_{t ∈ T_topic, n_p(t) > 0, n_q(t) > 0}  min(n_p(t), n_q(t)) · spec(t)
peer(p, q)   = shared(p, q) ≥ PEER_THRESHOLD      // 4.5 in the mock; derive from labeled queries
```

Shared topics are listed most-specific first.

### 4.6 Explanations

Deterministic, no LLM: `"{docs} docs · {strong} strong · {partial} partial · {years}"`,
office, top three matched topics with counts. An LLM "why this person" line is a
follow-up after the ranking is trusted.

## 5. API

### 5.1 `POST /api/experts`

Request:

```json
{ "query": "electric buses", "excluded_topics": ["Public Transit"], "top_n": 20 }
```

- `query` required, trimmed, non-empty → 400 otherwise.
- `excluded_topics` optional: removed from `T_topic` before scoring and from the graph.
  Does not touch the `/query` call.
- `top_n` optional, default 20, max 50.

Response:

```json
{
  "ok": true,
  "query": "electric buses",
  "mode": "evidence" | "topic_only",
  "understanding": {
    "matched_topics": [{ "label": "Electric Mobility", "cosine": 0.66, "df": 20 }],
    "matched_geographies": [{ "label": "China", "cosine": 0.41, "df": 49 }],
    "likely_off_topic": false,
    "suggestions": [{ "type": "nearby_topic", "text": "…" }],
    "degraded": []
  },
  "people": [{
    "key": "xue, lulu",
    "name": "Xue, Lulu",
    "office": "WRI China",
    "offices": { "WRI China": 19, "WRI Global": 2 },
    "score": 1.0,
    "evidence": { "docs": 21, "strong": 3, "partial": 15, "weak": 3,
                  "years": [2014, 2025], "corpus_docs": 27 },
    "topics": [{ "label": "Zero-Emission Trucks", "n": 10, "matched": true }],
    "doc_ids": ["2025_zero-emission-heavy-duty-trucks_00015"]
  }],
  "total_people": 235,
  "docs": {
    "2025_zero-emission-heavy-duty-trucks_00015": {
      "title": "Charging Toward 2035 …", "year": 2025, "type": "Report",
      "office": "WRI China", "tier": "strong", "url": "https://…",
      "authors": [{ "key": "chen, ke", "name": "Chen, Ke", "org": false }],
      "topics": ["Freight Transport", "Zero-Emission Trucks"], "geographies": ["China"]
    }
  },
  "organizations": [{ "name": "Coalition for Urban Transitions", "docs": 9 }],
  "usage": { "total_usd": 0.012 },
  "timing": { "query_ms": 2100, "tags_ms": 90, "db_ms": 40, "rank_ms": 5 }
}
```

`docs` is keyed by the work's original `doc_id` and contains every work referenced by
any returned person's `doc_ids` (evidence set) plus, in `topic_only` mode, the tagged
works that produced the score. Each entry carries `translations: [doc_id, ...]` for its
confirmed translation rows so the evidence panel can show "also in Spanish". All
`evidence` counts (`docs`, tiers, `corpus_docs`) are over works. The graph is derived
client-side from `people` and `docs`; it is not in the payload.

Errors: 400 for a bad body; 502 with `{ ok: false, error }` when both upstream calls
fail; otherwise degrade (section 9).

### 5.2 `POST /tags/nearby` (search service, additive)

```json
{ "query": "electric buses", "facets": ["topic", "geography"], "top_k": 10 }
```

```json
{ "facets": { "topic": [["Electric Mobility", 0.66]], "geography": [["China", 0.41]] },
  "model": "cohere-embed-v4", "degraded": [] }
```

Uses `topic_sense.nearby_tags(embedding, facet)` per facet. That function currently
reads `topic_sense_top_k` from settings and has no `top_k` parameter, so it gains an
optional `top_k` keyword (default: the setting, so `/query`'s tag lanes are unchanged).
The cosine floor stays the configured one. A facet with no `tag_embeddings` coverage
returns `[]` and is named in `degraded`. Never raises for a facet failure.

`search-service/app/main.py` has no router pattern today (`app/routers/` is empty), so
the endpoint is registered in `main.py` next to `/query` unless the implementer prefers
to introduce `APIRouter`; either is acceptable, neither is "the existing pattern."

Why not read `query_understanding.matched_tags` off `/query` instead: on QA it already
carries both topic and geography (`EXPANSION_FACETS`), but it is capped at
`topic_sense_top_k = 3` and only populated when the expansion lanes are active. Three
topics is too few for the graph. Raising the setting globally would change retrieval,
which is out of scope, so the endpoint is the additive path. `matched_tags` remains a
fallback source when `/tags/nearby` is degraded.

### 5.3 Query log

Migration adds `experts_mode_query_logs (id serial, query text, mode text,
top_ten_people text, timestamp timestamptz default now())`, written fire-and-forget from
the page after results render, mirroring `cite_mode_query_logs`.

## 6. Author identity and organizations

Splitting the stored string reuses `parseAuthors` in `src/app/utils/utils.tsx`
(semicolon-only split; its comment explains why commas are not separators). Keying is
`authorKey(raw, siblings)` in `src/lib/experts/authorKey.ts`, pure, where `siblings`
is the set of all raw author strings across the candidate works:

1. Trim; collapse internal whitespace; insert a space after a comma that lacks one.
2. If the string contains a comma: `family, given` → `key = lower(family) + ", " +
   lower(first given token)`.
3. Else if it is an organization (below): `key = lower(name)`, `org = true`.
4. Else the string is an unsplit personal name (`Given Family`, possibly a compound
   family name such as `Nicolás García Córdoba` or `Hellen Njoki Wanjohi-Opil`). Do not
   guess the split. Look for a sibling in `Family, Given` form whose family name is a
   suffix of this string and whose first given token matches its first token; if found,
   adopt that sibling's key. If none is found, key on `lower(last token) + ", " +
   lower(first token)` and flag `unverified: true` so the UI can show the name as stored.
5. Display name: prefer a `Family, Given` variant seen for that key; else the raw string.

Organization when there is no comma and an institutional keyword matches
(`institute|center|centre|council|coalition|bank|ministry|agency|university|programme|
program|initiative|partnership|association|foundation|wri|world resources|group|network|
alliance`). Word count is **not** a signal: four-word personal names are common in the
corpus. Organizations are excluded from `people` and returned in `organizations` with
work counts.

This is a stopgap until #411 normalizes the stored values; the key logic stays because
residual variants will exist. Test fixture: the 25 variant pairs listed in #411, plus the
compound-name examples above.

## 7. Page

Route `/experts`, unlisted: no link from `/` or the navbar, `<meta name="robots"
content="noindex">`, and the same "For WRI staff use only" `AlertBanner` as the landing
page. URL state: `?q=…&person=<slug of key>&exclude=<topic>,<topic>` (the key is slugified for the URL and mapped back client-side).

Layout and interaction follow the mockup exactly. Components:

| Piece | Reuse / new |
|---|---|
| Navbar | existing `Navbar`; "New search" routes to `/experts` |
| Query strip | design-system `Textarea` + primary `Button`, as on the landing card; `QuerySuggestions` with an experts pool (its `mode` type is `'cite' \| 'answer'` today and widens to include `'experts'`) |
| Interpretation line | new `TopicChips`, styled like `InterpretationLine` but with a strength slot; the existing component's `FacetChip` has no cosine field, so it is a sibling, not a reuse. Matched topics and geographies, cosine shown small, removable → re-post with `excluded_topics` |
| Summary line | "‹N› people across ‹M› offices, on ‹K› documents that match. Showing the top 20." |
| Ranked list | new `ExpertsList` / `ExpertRow` (rank, name, office dot+label, gold relevance bar, evidence line, top 3 matched topic chips); rows are buttons |
| Graph | new `TopicGraph` (section 8) |
| Evidence panel | new `ExpertEvidence`: offices with counts, "‹n› of ‹corpus_docs› documents match", docs by tier then year with tier chip and "author i of n", titles open `DocumentPreviewModal`, "Works alongside" peers (click switches selection), all topics as chips with matched ones gold |
| Organizations strip | new, under the list |

States:

| State | Treatment |
|---|---|
| Idle | query strip, three suggestions, one-paragraph explainer: evidence is published work only; no contact details |
| Loading | previous results held at reduced opacity; else skeleton rows and a graph card with a spinner |
| Results | as above |
| Silent corpus (`topic_only`) | amber banner; ranking and graph from topic space |
| Nothing | "No one in the corpus has published near this." + `EmptyStateTopics` chips |
| Error | design-system `InlineMessage` with retry; query and chips preserved |

Visual system (from the mockup): warm off-white ground, near-black ink, WRI gold as the
single accent meaning "relevance to the query"; office colors capped at three validated
hues (WRI Global, WRI China, WRI India) plus one neutral, with the exact office always in
text; Public Sans in the mock, replaced by the app's configured face in implementation.
Light and dark themes both defined.

## 8. Graph

- **Dependency:** `d3-force` only. Layout runs synchronously to convergence once per
  result set (`simulation.tick()` ×360, seeded `randomSource` for determinism), then
  React renders SVG. No layout animation; reduced-motion safe.
- **Nodes:** the listed people (≤ `top_n`) and matched topics (≤ 10). Person radius
  `7 + 13·score`; topic radius scales with cosine. Person fill by office group; topic as
  a gold ring on the surface.
- **Edges:** person→topic where `n_p(t) > 0`, width `0.8 + 0.7·min(n, 5)`.
- **Labels:** all topics; people ranked ≤ 8 at rest, others on hover, peer highlight, or
  selection.
- **Hover person:** own edges and topics gold, peers ringed gold, rest at 16% opacity;
  hint line states it in words. **Hover topic:** inverse.
- **Select person:** ink halo (`r + 6`, ink stroke, surface gap) and an ink name tab
  with surface text; the list row gets an ink left rule. Hover is halo-only, so pinned
  and hovered differ. Selecting again unpins.
- **Accessibility:** the list is the graph's table twin and carries every interaction
  from the keyboard; SVG has `role="img"` and a description; legend includes the
  selected-person key.

## 9. Error handling

| Failure | Behavior |
|---|---|
| `/tags/nearby` fails or degraded | rank on `E` only; `understanding.degraded` names it; graph shows only topics from the docs' own accepted tags (top 10 by specificity × count) |
| `/query` fails | `topic_only` mode with the banner; `degraded` names it |
| both fail | 502; page error state |
| DB join fails | 500; page error state |
| `excluded_topics` empties `T_topic` | evidence only; chips remain removable |
| no year / office on a doc | recency 0.7; office "Office unknown" and neutral color (no searchable doc on QA has a null today; the path is defensive) |
| `WRI México` / `WRI Mexico` | normalized on read to one office; same treatment for any future accent or spacing variant |
| translation rows both retrieved | collapsed to one work with the best tier; never two rows for one person's one work |

## 10. Testing

- **Pure (Jest):** `rank.ts` — weights, normalization, `topic_only` branch, specificity
  effect on a hub topic, position and recency; `authorKey.ts` — the 25 variant pairs from
  #411 collapse, comma-without-space, organizations; `peers.ts` — threshold and ordering;
  `layout.ts` — identical positions for a fixed seed.
- **Route (Jest):** `/api/experts` with mocked `fetch` and a stubbed query module:
  happy path, each degraded path, `excluded_topics`, validation.
- **Components (Jest, jsdom):** list and evidence render from a fixture response; hover
  and select propagate; silent-corpus and nothing states.
- **DB (Jest, `*.db.test.ts` pattern, skipped without `DATABASE_URL`):** the evidence
  join returns authors in order, accepted tags only, `df` counts over works, and
  collapses a confirmed translation pair to one work.
- **Python (pytest):** `/tags/nearby` per-facet results, cosine floor, `top_k`
  override leaves the settings default untouched, degraded facet, never raises.
- **Measurement instrument (before any weight is called tuned):** a labeled set of
  10–20 queries with the expected top-3 people, written with someone who knows the
  Cities program, stored under `evaluation/experts/`. Small-n justifies direction only;
  no threshold in §4 is derived until it exists. Until then every constant in §4 is
  labeled a prototype default in code comments, with the cost of changing it noted.

## 11. Non-goals

No changes to `/query` or retrieval tuning. No LLM explanations. No people entity,
profiles, or contact details. No navigation entry or public exposure. No production
deploy. Geography in the score, author-vector signal, and an eval harness for the
ranking are follow-ups.

## 12. Sequencing (for the implementation plan)

1. `/tags/nearby` endpoint (+ `top_k` kwarg on `nearby_tags`) + pytest.
2. Migration for `experts_mode_query_logs`; `expertsEvidence.ts` join (works, tags,
   `df`, office normalization) + db test.
3. Pure modules: `authorKey`, `rank`, `peers` + tests.
4. `/api/experts` route (sequential upstream calls, `max_results: 200`) + route tests.
5. Page: list, evidence panel, states; then `TopicGraph` with `d3-force` + `layout.ts`.
6. Query log write; labeled query set skeleton under `evaluation/experts/`; final
   cross-cutting review against the mockup.

## 13. Premise-check record (2026-09-09)

An adversarial review of the first draft found two broken premises and five weakened
ones; all are folded in above. Kept here so the next reader knows what was checked.

| Premise in draft | Verdict | What changed |
|---|---|---|
| `D` from `/query` represents the corpus | broken: UI preset caps at 25; reranker window ≈100 docs | `max_results: 200`; ceiling stated (§3) |
| Counts are over documents | broken: 11 confirmed translation pairs, 9 with identical authors | all counts over works (§4.1, §9) |
| Aggregation must be app-tier | preference, not constraint: Python already reads these tables | stated as a choice (§3) |
| `matched_tags` is topic-only | half true: QA has topic + geography; cap of 3 is the real limit | reason corrected (§5.2) |
| `/tags/nearby` reuses the cached embedding | only if sequential | calls made sequential (§3) |
| No LLM call per query | QA already makes one in `/query`'s understanding sidecar | noted; `likely_off_topic` is QA-only (§4.4) |
| "last token is the family name" key rule | reproduces the #411 failure on compound names; 4-word org rule misfires | sibling-form lookup, keyword-only org rule (§6) |
| Weights are tunable | no instrument exists | labeled query set added to testing and sequencing (§10, §12) |

Premises that held: per-doc tiers, hub-topic specificity, `d3-force` as a new
dependency, a new log table (the cite log lacks `mode`).
