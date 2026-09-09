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

- **Hub topics.** "Transport decarbonization" is on 155 of 201 docs. Any tag-based
  signal that ignores topic frequency connects everyone to everyone. Every use of a
  topic in this design is weighted by specificity `ln(N / df)`.
- **Split author identities.** 122 author entries on 30 docs are stored `Given Family`
  (CSV-imported rows) while worker-extracted rows store `Family, Given`; 25 people appear
  under two spellings (#411). Aggregation must group on a normalized key.

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

**Sequence** for one request: the route fires `/query` (cite preset, same options as
cite mode) and `/tags/nearby` in parallel; then one SQL round trip loads authors, office,
year, doc type, and accepted topic/geography tags for every candidate document; then
`rank()` runs. Expected latency: cite mode plus roughly 100 ms.

**Why not the alternatives.** A search-service-native `/experts` would pull author and
catalog logic into the Python tier that the app owns today. Precomputed author vectors
would be fastest but rank people on something other than the documents that actually
matched; that is a candidate later signal, not the MVP.

## 4. Ranking

### 4.1 Inputs

- `D`: docs from `/query` with `relevance_tier ∈ {strong, partial, weak}` and rank.
- `T_topic`: top 10 topic tags by cosine, floor 0.30 (`topic_sense_min_cosine`).
  `T_geo`: top 3 geography tags, same floor.
- For each candidate doc: authors in stored order, `wri_primary_office`,
  `year_published`, `article_type`, accepted topic tags with confidence, accepted
  geography tags.
- `N`: count of searchable docs; `df(t)`: searchable docs with accepted tag `t`.

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

`docs` contains every doc referenced by any returned person's `doc_ids` (evidence set)
plus, in `topic_only` mode, the tagged docs that produced the score. The graph is
derived client-side from `people` and `docs`; it is not in the payload.

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

Uses `topic_sense.nearby_tags(embedding, facet)` per facet with `top_k` overriding
`topic_sense_top_k` and the configured cosine floor. A facet with no `tag_embeddings`
coverage returns `[]` and is named in `degraded`. Never raises for a facet failure.

### 5.3 Query log

Migration adds `experts_mode_query_logs (id serial, query text, mode text,
top_ten_people text, timestamp timestamptz default now())`, written fire-and-forget from
the page after results render, mirroring `cite_mode_query_logs`.

## 6. Author identity and organizations

`authorKey(raw)` in `src/lib/experts/authorKey.ts`, pure:

1. Trim; collapse internal whitespace; insert a space after a comma that lacks one.
2. If the string contains a comma: `key = lower(family) + ", " + lower(given)`.
3. Else if it is an organization (below): `key = lower(name)`, `org = true`.
4. Else treat as `Given Family`: last token is the family name; `key` as in step 2.
5. Display name: prefer any `Family, Given` variant seen across the candidate docs for
   that key; else the raw string.

Organization when there is no comma and either an institutional keyword matches
(`institute|center|centre|council|coalition|bank|ministry|agency|university|programme|
program|initiative|partnership|association|foundation|wri|world resources`) or the entry
has four or more words. Organizations are excluded from `people` and returned in
`organizations` with document counts.

This is a stopgap until #411 normalizes the stored values; the key logic stays because
residual variants will exist.

## 7. Page

Route `/experts`, unlisted: no link from `/` or the navbar, `<meta name="robots"
content="noindex">`, and the same "For WRI staff use only" `AlertBanner` as the landing
page. URL state: `?q=…&person=<slug of key>&exclude=<topic>,<topic>` (the key is slugified for the URL and mapped back client-side).

Layout and interaction follow the mockup exactly. Components:

| Piece | Reuse / new |
|---|---|
| Navbar | existing `Navbar`; "New search" routes to `/experts` |
| Query strip | design-system `Textarea` + primary `Button`, as on the landing card; `QuerySuggestions` with an experts pool |
| Interpretation line | `InterpretationLine` chip idiom; matched topics and geographies, cosine shown small, removable → re-post with `excluded_topics` |
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
| no year / office on a doc | recency 0.7; office "Office unknown" and neutral color |

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
  join returns authors in order, accepted tags only, and `df` counts.
- **Python (pytest):** `/tags/nearby` per-facet results, cosine floor, degraded facet,
  never raises.

## 11. Non-goals

No changes to `/query` or retrieval tuning. No LLM explanations. No people entity,
profiles, or contact details. No navigation entry or public exposure. No production
deploy. Geography in the score, author-vector signal, and an eval harness for the
ranking are follow-ups.

## 12. Sequencing (for the implementation plan)

1. `/tags/nearby` router + pytest.
2. Migration for `experts_mode_query_logs`; `expertsEvidence.ts` join + db test.
3. Pure modules: `authorKey`, `rank`, `peers` + tests.
4. `/api/experts` route + route tests.
5. Page: list, evidence panel, states; then `TopicGraph` with `d3-force` + `layout.ts`.
6. Query log write; final cross-cutting review against the mockup.
