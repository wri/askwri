# MCP search surface — first hand-check (2026-10-01)

The evidence the design asked for: what actually happened when a real person
asked a real assistant real questions. Written with the bad parts included.

## How it was run

Claude Desktop on the author's machine, connected by a bridge to a copy of the
app running locally. The local app and search service were pointed at the QA
database, so the corpus and its embeddings are the real ones (201 documents,
34,791 passages). Nothing was deployed. No password was set at this point.

## Question 1 — something the corpus covers well

> "Search WRI's published research for how cities are adapting to extreme heat."

The assistant called the search tool and answered with seven grouped findings,
each carrying a document title, a page number and a link. It added three caveats
nobody asked for:

- most findings are recommendations or descriptions of plans, not evaluations of
  what worked;
- several sources are advocacy-oriented and geographically skewed, so the sample
  may lean toward WRI India;
- the links were `localhost` addresses, so they might not open elsewhere.

It also separated documents it had consulted but not relied on.

**Its citations were checked against the corpus.** Three claims, chosen at
random:

| What the assistant said | What the corpus says |
|---|---|
| Ahmedabad's plan saves almost 1,200 lives — Seizing the Urban Opportunity, p.24 | that document, p.24 |
| Mumbai budget-tagging found ~75% — Equitable, Productive..., p.209 | that document, p.209 |
| Portland shut trams after cables melted — Sustainable Urban Mobility in the NDCs, p.13 | that document, p.13 |

All three correct. This is the failure we feared most — plausible, well-linked,
wrong in the detail — and it did not happen in the sample.

## Question 2 — something the corpus does not cover

> kelp farming in Patagonia

The assistant searched twice with different wording, then refused:

> "The WRI corpus has nothing on kelp farming in Patagonia. Two searches...
> returned no relevant results. The only hit was a weak, irrelevant match: a
> Mexican business-census table in *Índice de Desigualdad Urbana* (2020).
>
> This doesn't prove WRI has published nothing on the topic. The corpus may be
> incomplete, or WRI may cover it under other terms such as 'blue carbon'...
> I can try those terms if you want."

It read the weak label correctly, refused, and added the caveat that finding
nothing is not proof of absence — which is a caveat we did not think to instruct.

## What the labels actually did

They were not printed per finding; they were used. The assistant wrote *"only the
first two results were rated strong"* and drew its evidence-quality caveat from
that. So the labels functioned as a judgment signal rather than as decoration,
which is what the design hoped for and could not previously demonstrate.

## Defects this exposed

1. **The reply is bulky.** Each passage runs to roughly 800 characters and ten
   come back, so an assistant receives several thousand characters per question.
   It worked here; on a broad question it will crowd out the conversation. Fewer
   passages by default, or a tighter passage window, is the obvious fix.
2. **No authors, ever.** Not one document came back with authors attached, so
   nothing in any answer carried one. Year sometimes appears; authors never do.
   Either the corpus metadata is thin or we are reading it from the wrong place.
3. **The thin-corpus note is our sentence being repeated.** It worked, which is
   what we wanted — but it means we may be supplying the judgment rather than the
   assistant reaching it. Worth knowing: if that note is wrong, the assistant will
   confidently repeat our mistake.

## What this does not tell us

- Whether links resolve from a real public address. Locally they are
  `localhost`, which the assistant correctly flagged itself.
- Cost per question. Two searches for the empty question, more for the full one;
  no totals were collected.
- What happens when the search service is unavailable.
- Anything about more than one user, since there is no identity yet.

## Verdict

Search alone, with no answer-writing by us, was enough for a genuinely useful
answer: specific findings, real citations, honest caveats, and a refusal that
held under a question the corpus could not answer. The main worry going in —
plausible answers with real-looking citations that are wrong — did not appear.
