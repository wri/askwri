# AskWRI for Other Assistants — Search Surface Design (2026-10-01)

**Status:** design approved in session. Not an implementation plan; the next step is a
writing-plans pass over §4–§9.

**Built and hand-checked (2026-10-01):** the surface exists — one read-only tool at
`/api/mcp`, behind the shared key in §5 — and it was used from Claude Desktop against the
real QA corpus. Evidence, including the defects found:
`docs/plans/2026-10-01-mcp-hand-check.md`. How to connect an assistant:
`docs/runbooks/askwri-mcp-connector.md`. Three things that document changes, listed here so
this one is not read alone: the reply is bulkier than it should be (ten passages at roughly
800 characters each); no document came back with authors, so no answer carried any; and the
thin-corpus note in §2 is our sentence being repeated by the assistant, so if that sentence
is wrong the assistant repeats our mistake confidently.

**Continues:** `docs/plans/2026-08-13-agent-persona-design.md` (the agent-persona capture),
which ended as a brainstorm with nothing built. This one narrows it to the smallest useful
surface and settles the questions that capture left open.

**Goal, in the words it was set:** a human — or an agent running on their behalf — who
already works inside Claude Desktop, ChatGPT, Cursor, or similar should get a **genuinely
useful and understandable response** from AskWRI without visiting our site.

---

## 1. What changes from the 2026-08-13 capture

| # | old position | now | why |
|---|---|---|---|
| 1 | Refuse #7: "No separate MCP / SDK build (HTTP JSON first; an MCP shim can wrap `/api/agent/*` later)" | **Reversed.** The standard is the surface; we do not invent one | MCP did not exist as a realistic target when that was written. Inventing a private agent API means advertising and versioning it ourselves |
| 2 | Decision #3: build one composite `/api/agent/ask` that collapses retrieve-then-write | **Dropped for v1** | Its stated reason (§3 gap 1, "the two-step is the universal friction") was agent-side fragility. The caller here is a strong model that can compose the two steps itself. The reason does not hold |
| 3 | §5.4 token per human, quota headers, `api_tokens` table | **Deferred.** One shared key, no identity | Deliberately deferred, not overlooked — see §5 and §8 |
| 4 | §5.3 `/api/agent/extract`, §5.6 proposal/disposal ledger | **Dropped for v1.** Surface is read-only | Nothing in the response writes to AskWRI, so there are no proposals and no disposal debt |
| 5 | §9.4 walls: structural honesty, disposal, citation ergonomics | **Retained, but two of the three work differently here** | See §10. We can refuse *our* answer, not theirs; the citation lever is an instruction, not a mechanism |

The old capture's §3 finding still stands and is the reason this is cheap: the read endpoints
are already structured JSON, so this is exposing and trimming, not building.

---

## 2. The surface

**One tool. Read-only.**

`search_wri` — search the WRI published corpus and get back passages with citations.

| input | required | notes |
|---|---|---|
| `query` | yes | the question or topic, in the person's own words |
| `year_from` | no | earliest publication year → `min_year` |
| `year_to` | no | latest publication year → `max_year` |
| `max_results` | no | defaults to the cite-mode preset |

**Output: readable text, not JSON.** The tool description tells the assistant what the
relevance labels mean and to keep the links when it answers. One block per result:

```
WRI corpus results for "compact urban growth in India"
10 passages. Relevance is strong / partial / weak: strong means the passage
directly addresses the question, weak means it is tangential.

1. "Cities at the Crossroads" (2024) [strong]
   Passage: "Between 2019 and 2026 compact-growth policy in Indian cities shifted
   from land-use mandates toward transit-linked density bonuses..."
   Page 12 — https://<origin>/api/pdf/DOC-1234.pdf#page=12
   Authors: A. Sharma, L. Chen

2. ...
```

When the corpus looks thin, a plain sentence opens the response, because the search service
already tells us:

```
The core topic of this question appears to be absent from this corpus.
Treat the passages below as tangential.
```

**Fields per result, and nothing else:** title, passage, page, link to that page, relevance
label, authors, year.

Three decisions inside that shape:

- **Text, not structured data.** A person who looks at what their assistant received can read
  it, and it costs fewer tokens than repeating field names ten times. The cost: an agent that
  wants to parse the result has to parse prose. Two representations now is worse than adding
  one later if someone asks.
- **Trimmed, not passed through.** The existing search response duplicates the whole document
  list under both `docs` and `sources`, nests the passage under `kps[0]`, and attaches a raw
  metadata blob per document (`src/app/api/llamaindex/route.ts:167-236`). That shape exists
  for our pages. Handing it over spends the other assistant's attention on repetition.
- **`strong`/`partial`/`weak` is the strength signal, not the raw score.** The relevance tier
  is calibrated against our golden sets; the raw score is not stable across model changes
  (old capture refuse #8).

### 2.1 Why there is no answer tool

The existing writing step is `POST /api/answer`. Two facts disqualify it from v1:

1. It requires the caller to bring documents already (`src/app/api/answer/route.ts:231`), which
   is precisely the two-step this design declines to collapse (§1 row 2).
2. Its output is engineered to be short — the prompt asks for *"exactly 2-3 clear sentences,"*
   built from one key finding per document, not from the passages
   (`src/app/api/answer/route.ts:407`). On our site those sentences sit **above** a list of
   citation cards; they are a lede, not the payoff. Inside someone else's tool they would be
   the whole answer, and a thin one.

Revisit when there is evidence people want our prose rather than their assistant's.

---

## 3. What this builds on (verified 2026-10-01)

| fact | where |
|---|---|
| Only the web app is reachable from the internet; the search service is internal | `terraform/infrastructure/alb.tf:98-104` (host-based rule → app target group only) |
| Search is one call to the internal service | `src/app/api/llamaindex/route.ts:128` |
| Which fields the search route will forward (allowlist; unknown fields are rejected 400) | `src/lib/llamaindex-client.ts:9` |
| Year filters are real, not invented | `search-service/app/main.py:164-165` (`min_year`, `max_year`) |
| The relevance label per passage | `docs[].metadata.relevance_tier` → `relevance_tier` in the route's output |
| The "corpus looks thin" signal | `likely_off_topic` in the search response (`likely_off_topic`, slice 6 / #356) |
| The passage text, already stripped of the `**[...]**` window markers | `extractPassage`, `src/app/api/llamaindex/route.ts:189` |
| The citation link our own UI already uses | `src/app/components/AnswerMode/CitationCard.tsx:282` → `/api/pdf/<doc_id>.pdf#page=N` |
| That PDF route is public, serves by document id, and 404s withdrawn documents | `src/app/api/pdf/[filename]/route.ts` |
| A log table that fits, with a nullable "who" | `src/db/entities/AuditLog.entity.ts` (`actor_user_id` nullable, `before`/`after` jsonb) |

**On the old capture's field list:** it listed `has_english_translation` and `program_series`
as available in the retrieval response. Both are there — but only inside a raw metadata blob
(`meta: { raw: doc.metadata }`, `src/app/api/llamaindex/route.ts:205`), not as top-level fields.
The blob is one of the things this surface drops (§2), so neither field is included here. The
old capture was right at the level it was speaking at; an earlier revision of this document
wrongly called it wrong.

---

## 4. Where the code goes

A new route in the existing app: `src/app/api/mcp/route.ts`, Node runtime, stateless.

- Same public origin as the site, so no new server, certificate, or network rule.
- New dependencies: `mcp-handler` (which mounts as a Next.js route export and serves both the
  current MCP specification and 2025-era clients) and the server package it is built on,
  `@modelcontextprotocol/server`, which requires `zod` v4. Stateless POST handling is enough for
  a tools-only server; no session or streaming machinery in v1.
- **The key check and the result formatter live in `src/lib/mcp/`, not in the route file.** A
  Next.js route module may only export its handlers and segment config — anything else fails
  the type check that runs during `next build`, and the build is the QA deploy gate.
- **It reuses our own `/api/llamaindex` route handler in-process** — importing that module's
  exported `POST` — rather than refetching over the network or refactoring a 289-line route that
  serves the website. Caveat, found by the premise check and unresolved: whether a Next 16 route
  module can be imported and called from another server module is unverified. The plan tests it
  as its own case before building on it; if it fails, the fallback is to call the internal search
  service directly using the same request preset.
- The website's `/api/llamaindex` contract is not modified. The trimming happens in the new
  code.

---

## 5. The key

- One secret string, held with our other secrets.
- **It travels in the address, and for the two tools that matter most that is the only option.**
  Verified 2026-10-01: Claude Desktop's custom-connector screen takes a URL and, in advanced
  settings, only OAuth client credentials — there is no field for a bearer token or custom
  headers (an open issue on Anthropic's tracker is exactly this complaint). ChatGPT's
  developer-mode apps support OAuth, no authentication, or a mix; also no static key. Cursor
  accepts headers, so the credential form is a convenience for the rest, not the primary path.
- Consequence, stated rather than discovered later: a key in a URL is visible in organizational
  settings and travels by copy-paste. It is a weak gate, not a boundary. Tolerable only because
  this surface is read-only and spends nothing but embeddings and reranking.
- A wrong key gets a plain, readable refusal, so a person can distinguish "key is wrong" from
  "the service is down."
- Separate keys for QA and production.
- Rotating breaks every connected tool until each updates its address. That is the standing cost
  of a single key shared by everyone.
- No per-person identity, by decision. Consequence, stated plainly: we cannot attribute a
  question to a person, cannot cap one person's use, and cannot follow up with whoever asked.
- **Correction to an earlier claim made while designing this:** adding a key later is not "a
  small change where people paste it once" for Claude Desktop — that field does not exist. Per-
  person identity there means OAuth, which is the real work. Choosing an open surface now does
  not keep that door as cheap as it looked.

---

## 6. How someone connects

They open their assistant's connector settings, add our address with the key in it, and enable
it. Nothing to install on their machine; the address is our normal site address plus a path.

Claude reaches us from Anthropic's cloud rather than from the person's device, so the request
the service receives does not come from their network. That rules out treating the source
address as identity or as a usage limit.

Honest limit: a few tools accept only locally installed tools rather than an address. Those
need a small per-person bridge program (a third-party one exists — `mcp-remote`). **Not built**
— we write the note. Claude Desktop, ChatGPT, and Cursor all accept an address.

---

## 7. What we write down

One row per call in the existing `audit_log`: when, the question, result count, whether the
corpus looked thin, the cost, and the duration. The table already has a nullable "who," so it
works with no identity. No new table.

One new value in the action list (`src/db/queries/audit.ts:5`).

This is the piece with the least visible payoff and probably the most value: the record of what
people ask for is the "what should WRI be researching" signal the old capture kept circling. It
arrives as a side effect of logging, not as a feature anyone has to build.

---

## 8. Proving it works

1. **By machine** — each result carries the agreed fields; a wrong key is refused; an off-topic
   question gets the thin-corpus note; none of the website's plumbing (duplicate document list,
   raw metadata, internal scores) appears in the text; the year limits actually filter.
2. **By hand, live** — connect a real assistant; ask three questions, one the corpus answers
   well, one thinly, one not at all; confirm every link opens the right document at the right
   page.
3. **On paper** — those three questions and the raw responses saved beside this design, so
   "genuinely useful" has evidence rather than a feeling.

Check 2 is the one that decides whether this was worth doing. Link resolution specifically: the
`#page=` jump is a viewer feature, not a guarantee.

---

## 9. Open questions for the plan

1. **Rate limiting.** With one shared key and no answer synthesis, a call costs an embedding
   and a rerank. Small, not zero. Leaning: a simple in-memory per-caller cap from the start,
   because the alternative is discovering abuse from a bill.
2. **`max_results` default and ceiling.** Current cite preset vs. something smaller for a
   context budget that is not ours.
3. **Whether to expose the year limits to the model at all**, or only in the tool description
   ("set these only when the person named a range"). Leaning: expose them, with that instruction.
4. **Exact wording of the tool description** — it is the only lever on citation survival.
5. **Whether QA is open to the world too**, or internal-only until the production cut.
6. **What to do with `likely_off_topic` when results still come back** — the field is a flag
   alongside results, not an empty result set. Wording matters.

---

## 10. Deliberately not built

Each with the signal that would change the decision.

| not built | reason | signal that would change it |
|---|---|---|
| **Our written answer** | §2.1 — the existing step is a 2-3 sentence lede built to sit above a citation list | people asking for our prose, or a demonstrated quality gap in host-written answers |
| **Translate, "how is this relevant", claim-vs-passage alignment, catalog** | each only makes sense once the caller already holds a document, so exposing them adds ways to go wrong without removing a step | observed demand, or the host models doing these badly enough to matter |
| **Structured output alongside the text** | two representations now is worse than one later | an agent that needs to parse results |
| **Per-person identity, quotas, an admin page** | deferred by decision (§5) | a reason to attribute, cap, or follow up with an individual |
| **A better permalink address** | the `#page=` link is what our own citation cards already use | link resolution failing in check 2, or links being visibly mangled in the wild |
| **A locally installed bridge for tools that need one** | Claude Desktop, ChatGPT and Cursor accept an address | a named tool that does not |
| **Anything that writes to AskWRI** | keeps the surface read-only, so no proposals and no disposal debt | a specific proposal the humans already want to dispose of |

### 10.1 Where the old capture's walls now stand

- **Structural honesty.** For our own output we control it, so a refusal is real. But we cannot
  stop the other assistant from writing an answer out of the weak passages it was handed. Our
  refusal is structural; theirs is not ours to control.
- **Citation ergonomics.** The old capture made a stable, human-resolvable link load-bearing
  (decision #11). Here the link exists and works, but the only thing keeping it attached to an
  answer is an instruction to a model. That is the weakest joint in this design, and it is named
  rather than papered over. **First evidence, 2026-10-01:** the assistant kept every link, with
  titles and page numbers, unprompted. One sample, one model, one day — weaker than it looks,
  but the joint did hold where it was most likely to fail.
- **Disposal.** Not applicable — nothing is proposed.

---

## 11. Out of scope for this artifact

Answer synthesis, extraction, conversation or memory of any kind, per-person identity and
quotas, agent-authored writes, per-tenant corpus scoping, any open-web search, and anything on
the admin side. The older capture's §10 stands.

---

*Approved in session 2026-10-01. Next step: a writing-plans pass over §2, §4, §5, §6, §7 and
§8, constrained by the two open joints in §10.1.*
