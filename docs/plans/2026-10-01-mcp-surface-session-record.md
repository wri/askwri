# Assistant-facing search — session record (2026-10-01)

One entry point for everything about letting other assistants use AskWRI. Written
so someone picking this up cold — or me in a month — does not have to reconstruct
the reasoning.

## The documents, and which is which

| Document | What it is |
|---|---|
| `docs/plans/2026-10-01-askwri-mcp-surface-design.md` | **The design.** What we decided and why. Read this first. |
| `docs/plans/2026-10-01-askwri-mcp-surface-implementation.md` | **The plan.** Six tasks, with status. |
| `docs/runbooks/askwri-mcp-connector.md` | **How to use it.** Connecting, the password, running a copy locally, testing it. |
| `docs/plans/2026-10-01-mcp-hand-check.md` | **The evidence.** What happened when it was actually used. |
| `docs/plans/2026-08-13-agent-persona-design.md` | The earlier thinking this continues. Its central plan was dropped; see below. |

## What was asked for

Make it easy for people using other tools — Claude Desktop, ChatGPT, an agent
working for someone — to use AskWRI's abilities, without coming to our website.
The success measure set in the session: **the person or their agent gets a
genuinely useful, understandable answer.**

## The decisions

1. **Use the existing standard rather than inventing our own interface.** The
   earlier document had explicitly refused this. That refusal was reversed: the
   standard is the surface, and inventing a private interface would mean
   advertising and maintaining it ourselves.
2. **One tool: search. No written answers from us.** The earlier plan was to
   build a combined "ask" call that would retrieve *and* write. It was dropped,
   for two reasons. The earlier reasoning assumed the caller was a fragile agent
   fumbling two steps; here the caller is a strong model that composes them
   itself. And our existing writing step produces two to three sentences designed
   to sit above a list of citations on our own pages — inside someone else's
   product that would be the whole answer, and a thin one.
3. **Nothing that writes.** Read-only, so there are no proposals and no review
   queue to keep up with.
4. **One shared password, no identity.** Deliberately deferred, not overlooked.
5. **The password is the weakest part, knowingly.** Claude Desktop and ChatGPT
   have no field for a credential, so the password travels in the web address:
   visible in settings, shared by copy-paste. A weak gate, accepted because
   searching is cheap and read-only.
6. **Results come back as readable text**, not a data structure, with the
   relevance label and a link on every passage, and the website's internal
   plumbing stripped out.

## What exists now

One tool, `search_wri`, at `/api/mcp`, behind the shared password.

```
75bdcd4  text formatter                      10 tests
60a3547  the tool itself                      6 tests
9fcf12d  the route that serves it             3 tests
a307bbf  formatting
a93cdf0  the password + all the documentation 8 tests
```

24 tests green. The production build passes and lists `/api/mcp`. Lint and
formatting clean. The full suite is unchanged from before this work — 26 failing
suites, all of them needing a database that is not running locally.

Each result carries: title, quoted passage, page, link, relevance label, authors,
year.

## Two things found before any code was written
A review whose only job was to attack the assumptions in the design and plan came
back with seven errors, all caught on paper:

- Exporting a helper from a route file fails the build. It lives in a library file
  instead.
- The route code referred to the incoming request, which is not available where
  the tool is defined. The address comes from the tool's context.
- The logging test would have failed at compile time on a naming rule.
- Search mode was justified with a claim that was backwards: it returns *more*
  results than the other mode, not fewer.
- Two claims about which fields exist in a reply, and which package requires
  which dependency, were wrong. One of them was me "correcting" the earlier
  document, when the earlier document had been right.

A second review, this one an automatic one that reads every commit before a push
is allowed, produced fifteen more items across all seven commits. All are either
fixed or dismissed with evidence, in the commit that follows. The three that
changed behaviour: a key containing `+` failed when pasted into an address; a
reply that was not the shape we expected was reported as "the corpus has no
answer" rather than as a failed request; and refusals were not logged, so
probing the password would have been invisible.

## What using it actually showed

Full evidence in the hand-check document. In short:

- A question the corpus covers well came back as seven grouped findings, each with
  a real document and page, plus three caveats nobody asked for. **Three cited
  claims were checked against the corpus and all three were correct.**
- The relevance labels were *used*, not printed: the assistant drew an
  evidence-quality caveat from them.
- A question the corpus does not cover got a refusal, with the assistant adding
  its own warning that finding nothing is not proof of absence.

## Known defects, found by using it

1. **Replies are bulky.** Ten passages at roughly 800 characters each. Fine here;
   it will crowd out the conversation on a broad question.
2. **No document returns authors**, so no answer carried any. Either the corpus
   metadata is thin or we read it from the wrong place.
3. **The thin-corpus warning is our sentence being repeated.** It works, but we
   may be supplying the judgement rather than the assistant reaching it — and if
   our sentence is wrong, the assistant repeats our mistake confidently.

A related trap when running a copy locally: retrieval can fail *quietly*, because
retrieval falls back rather than erroring. A successful-looking reply is not
proof the search ran properly — check that `/health` reports `dense_lane: live`
before trusting any result. The recipe is in the connector runbook.

## Still open

- **The password on a real deployment.** It reaches the app through the GitHub
  secret `ASKWRI_APP_ENV`. An operations job, no code change. Until it is added,
  a deployed endpoint refuses everything.
- **The call log.** Nothing is recorded yet, so there is no picture of what people
  ask for — the thing the earlier document argued would be the most valuable
  by-product.
- **The two defects above.**
- **One review of the whole branch** was planned and not run.
- **No visitor.** Nobody has asked for this. It was built to find out whether it
  is any good, and the first evidence says the mechanism works.

## State of the machine it was built on

Worth knowing, because both block the documented local setup:

- The local corpus is incomplete: 62 of the 169 documents. The one-command setup
  refuses to run with a partial corpus, which is why the QA-database route above
  exists.
- Port 5432 is held by another project's database container, so the local
  database in `docker-compose.local.yml` cannot take its usual port without a
  change.
