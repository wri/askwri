# Connecting an assistant to AskWRI search

AskWRI exposes one thing to other assistants: **search its published corpus and
get back passages with links.** That is the whole surface. It is read-only —
nothing an assistant does here changes anything in AskWRI.

## What a person gets

They ask their assistant a question. The assistant calls our search, and the
reply it receives looks like this:

```
WRI corpus results for "how are cities adapting to extreme heat"
10 passages. Relevance is strong, partial or weak: strong means the passage
directly addresses the question, weak means it is tangential.

1. "Modeling Hyperlocal Heat Exposure With Open-Source Data" (2026) [strong]
   Passage: "..."
   Page 1 — https://<address>/api/pdf/<document>.pdf#page=1
   Authors: ...
```

Each result carries: title, the quoted passage, the page, a link that opens that
page, the relevance label, authors, year. Nothing else — no internal scores, no
metadata.

Two behaviours worth knowing:

- **A strong/partial/weak label on every passage.** It comes from the retrieval
  system's own quality gate.
- **When the corpus is thin on the question, the reply says so first**, in plain
  words: *"The core topic of this question appears to be absent from this corpus.
  Treat the passages below as tangential."* The assistant is told to pass that on
  rather than answer as if the topic were covered.

## The address and the password

```
https://<site-address>/api/mcp
```

The password is the `MCP_SHARED_KEY` setting. It is presented one of two ways:

```
credential:  Authorization: Bearer <key>
address:     https://<site-address>/api/mcp?key=<key>
```

**Generate it with `openssl rand -hex 32`.** A key made only of `0-9a-f` needs no
encoding when pasted into an address. Other characters can work, but a `&` or `#`
would end the address early, and a `+` is the classic one that gets sent as a
space by whatever reads the address on the way. Not worth the trouble.

**Both forms exist because of a limit in the assistants themselves.** Claude
Desktop's connector screen has no field for a credential — only OAuth client
details — so for Claude and for ChatGPT the address form is the only one
available. Cursor accepts a header. If no key is configured at all, the endpoint
refuses everything.

Consequences worth stating plainly: a key in an address is visible in
organisational settings, travels by copy-paste, and is shared by everyone using
it. It is a weak gate. It is also the only gate available for the two assistants
that matter most. Per-person identity in Claude means a full OAuth setup, which
is separate work.

## Connecting

### Claude Desktop, to a deployed address

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "askwri": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<site-address>/api/mcp?key=<key>"]
    }
  }
}
```

Restart Claude Desktop. It shows up under Settings → Developer → Edit Config,
alongside other local servers. Claude reads this file at startup — and, observed
in practice, sometimes picks up an edit while running.

### Claude Desktop, to a copy on your own machine

Same entry, but point at `http://localhost:3000/api/mcp`. The bridge runs on your
machine, which is why `localhost` works — Claude's *remote* connectors talk to
your server from Anthropic's cloud and cannot reach your laptop.

### ChatGPT

Developer-mode apps (Pro, Plus, Business, Enterprise, Education) accept a remote
address with no authentication, OAuth, or a mix. There is no field for a shared
key, so the key must be in the address.

### Cursor

`mcp.json`, in the project or your home directory:

```json
{
  "mcpServers": {
    "askwri": {
      "url": "https://<site-address>/api/mcp",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

## Setting the password

- **Deployed:** the key reaches the app through the GitHub secret
  `ASKWRI_APP_ENV`, a JSON blob that terraform turns into container settings.
  Adding `MCP_SHARED_KEY` to that JSON and redeploying is all that is needed — no
  terraform change. Until it is added, the deployed endpoint refuses everything.
- **Local:** put it in `.env.local` (gitignored). Never in `.env`.

## Checking it works

The fastest check is a direct call, which needs no assistant:

```bash
curl -s -X POST 'https://<site-address>/api/mcp' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_wri","arguments":{"query":"urban heat"}}}'
```

The `accept` header is required by the protocol; without it the request is
refused with a message saying so.

Wrong password returns a plain 401 that names the key, so "wrong key" is
distinguishable from "service is down".

**In Claude Desktop, the ground truth is a log file:**
`~/Library/Logs/Claude/mcp-server-askwri.log`. If it is there and growing,
Claude is talking to us. Startup problems say why there.

## Running a copy on your own machine, against the real corpus

The one-command local setup (`./scripts/local-bootstrap.sh`) needs a complete
169-document corpus in `search-service/data`. If that is incomplete, the app and
the search service can instead run on your machine and read QA's database, which
already holds the corpus and its embeddings. Nothing is downloaded and Docker is
not involved.

The pattern is: export real AWS credentials, turn off the S3 substitute, and run
the command inside the environment script that reads QA's database details from
the deployed task definition.

**The search service** (leave running):

```bash
./scripts/with-remote-env.sh qa bash -c '
  eval "$(aws configure export-credentials --format env)"
  export AWS_ENDPOINT_URL=
  cd search-service
  nohup ./venv/bin/python -m app.main > /tmp/askwri-search.log 2>&1 &
'
```

**The app** (leave running), serving a build you have already made with
`npx next build --webpack`:

```bash
./scripts/with-remote-env.sh qa bash -c '
  eval "$(aws configure export-credentials --format env)"
  export AWS_ENDPOINT_URL=
  export SEARCH_SERVICE_URL=http://127.0.0.1:8000
  export DOCUMENTS_S3_BUCKET=askwri-data
  export DOCUMENTS_S3_PREFIX=documents/
  nohup npx next start -p 3000 > /tmp/askwri-app.log 2>&1 &
'
```

The password is picked up automatically from `.env.local`.

**Two things that will bite you:**

- **The app is pointed at QA's live database, with write credentials.** Reading is
  all this surface needs. Do not use that local copy for admin work: anything it
  writes lands in QA's corpus and is copied into production on the next release.
- `search-service/.env.local` holds made-up credentials for the local file-store
  substitute, and loads them into the process. Real credentials must be exported
  first or every retrieval call fails quietly while still returning 200. The
  `eval` line above is that fix; check `/health` for `dense_lane: live` rather
  than trusting a successful call.
- `AWS_ENDPOINT_URL=` (empty) is set on purpose. It is what redirects those calls
  to the substitute; an empty value means "use the real service".

**Stopping them:** `pkill -f "next start -p 3000"` and `pkill -f "app.main"`.
Both die on reboot.

## What to send someone who is going to try it

Copy the block below, fill in the two placeholders, and send it. It assumes the
address is deployed and the password is set (see "Setting the password" above).

> You can search WRI's published research from inside Claude.
>
> **Setup:** Claude Desktop → Settings → Connectors → Add custom connector →
> paste this address (the password is in it):
>
> ```
> https://<site-address>/api/mcp?key=<key>
> ```
>
> Restart Claude.
>
> **Then ask it something like:**
>
> > Search WRI's published research for how cities are adapting to extreme heat.
> > Give me the documents and page links you used.
>
> **Worth knowing:**
>
> - It returns WRI's own documents with page links. If an answer has no links, it
>   is not using the corpus.
> - When WRI has not published on a topic, it should say so instead of answering
>   anyway. Tell me if it bluffs.
> - This is an early test with one password shared by everyone. Please do not pass
>   the address around.
>
> **What I would like to know:** was the answer useful, and did the links open the
> right page?

Send the first question above: it is known to work, so a failure there means the
connection is broken rather than the topic being thin.

## What this does not do

- **No written answers from us.** We return passages; the other assistant writes
  the answer. That is deliberate — see the design doc.
- **No memory, no saved searches, no conversation.**
- **Nothing that writes.** No tags, no flags, no proposals.
- **No record of who asked.** Questions are logged with no identity, so nobody
  can be attributed, capped, or followed up with.
- **WRI's corpus only.** No open-web search.
