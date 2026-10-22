# Advisory sweep — 2026-10-22

Proactive CVE/advisory pass over everything this repo pins (bugfix-evidence Gate 3).
Report only: **nothing was upgraded here.** Upgrades are their own PRs — see
[Fix tranches](#fix-tranches).

Branch: `fix/advisory-sweep` (off `qa` @ `154c38d`).

## Method

| Rung | Command |
|---|---|
| npm, all deps | `npm audit --json` → `.sweep/npm-audit-all.json` |
| npm, runtime only | `npm audit --omit=dev --json` → `.sweep/npm-audit-prod.json` |
| pip, deploy pins | `docker run --rm -v "$PWD:/w" -w /w python:3.12-slim sh -c 'pip install pip-audit && pip-audit -f json -r requirements.txt'` → `.sweep/pip-audit.json` (run in `search-service/`) |
| Base images / runtime | `node:24-alpine`, `python:3.12-slim` (floating tags), local node 24.21.0 / py 3.12.12 |
| Terraform | `hashicorp/aws 5.100.0` (`terraform/infrastructure/.terraform.lock.hcl`) |
| Actions | `.github/workflows/*.yml` `uses:` refs |
| Advisory detail | GHSA pages + `osv.dev` + PyPI/GitHub API, accessed 2026-10-22 |

Counts: npm 1112 lock entries → 46 advisories (1 critical, 41 high, 4 moderate);
9 of those (1 critical, 6 high, 2 moderate) are in the **production** tree.
pip 103 pinned packages → **110 advisories across 9 packages**, one package
untouched (`pillow` and `nltk` are 35 each).

The production npm tree is small. Nearly all 41 highs sit in test/build tooling
(jest, eslint, tailwind, browserslist) and are not shipped.

## Findings, triaged by reachability

Severity below is *this deployment's* exposure, not the advisory's headline
severity. Each row says why it moved.

### P1 — fix before the next production release

**1. `next@16.3.6` — unauthenticated RCE in the Image Optimization API**
`GHSA-2464-fhr4-w9xw` (CVE-2026-96889 family), critical, patched **16.4.1**.
Same package carries `GHSA-cjq9-62q9-8jv4` (SSRF in image optimization, fixed
16.3.8), `GHSA-4jqv-mc3x-m676` / `GHSA-mcj8-r9mp-w47p` (SSG/ISR cache poisoning,
fixed 16.3.8), `GHSA-p3m5-59mp-jv5r` (Server Action DoS, fixed 16.4.1) and four
moderate + one low info-disclosure item.
*Reachability:* `/_next/image` is served by the standalone server and the ALB is
internet-facing (`terraform/infrastructure/alb.tf:8` `internal = false`) with no
WAF or CDN in front (`grep -rn 'cloudfront\|wafv2' terraform/` → nothing), so the
endpoint is reachable unauthenticated. `next.config.js` sets **no `images`
config**, so `remotePatterns` is empty and remote URLs are refused; the local-path
vector needs a same-origin attacker-controlled SVG, and today the only
file-serving route is `src/app/api/documents/[id]/route.ts`, which is
`application/pdf`-only behind a `doc_\d{6}` regex. So the RCE is **not reachable
today** — but it is one image route away, and the cache-poisoning fixes are
reachable now (self-hosted rendering, cross-user cached HTML). Patch cost is a
minor bump the repo already allows Dependabot to open.
Fix: **`next@16.4.2`** (latest at access date; ≥16.4.1 is the security floor).

**2. `pypdf@6.14.2` — 24 advisories, parsed on the ingestion path**
Sample `PYSEC-2026-3656`: a crafted PDF drives long runtimes and large memory.
`search-service/worker/stages/parse.py` calls `PdfReader` directly
(`_extract_pdf_metadata`, the ghostscript page-count check) and indirectly via
`llama_index.readers.file.PDFReader` — on **corpus and intake PDFs**, i.e.
third-party content. This is the most directly reachable advisory in the whole
sweep.
Fix: `pypdf>=6.21.2` (latest at access date; ≥6.15.0 clears the first batch).

**3. `sharp@0.35.4` — RCE via librsvg** `GHSA-wq5f-xc86-pv6w` (CVE-2026-114111),
high, patched **0.35.5**. Reached only through the image optimizer, so the same
reachability as finding 1. Ships with the `next` bump.

### P2 — fix in the following release, or when touched

**4. `@modelcontextprotocol/server@2.2.0`** (via `mcp-handler@2.2.0`,
`src/app/api/mcp/route.ts`), three advisories, all patched in **2.3.0**:
- `GHSA-jm63-cq47-j5jp` cross-client message delivery — **not reachable**.
  It requires a shared `McpServer`/transport across clients; `mcp-handler@2.2.0`
  constructs a fresh `McpServer` per request (`dist/index.js:199`), verified in the
  packed tarball.
- `GHSA-46jr-4wx8-v453` (CVE-2026-111768) memory exhaustion — an over-large
  array/record in one 4 MiB request OOMs the process. `route.ts` checks
  `isAuthorized()` before handing off, so it needs a **valid key**; ranked
  moderate, not high. Note the advisory: upgrading alone fixes nothing — it also
  needs `maxToolInputElements` set. `mcp-handler` spreads unknown options into
  `new McpServer(serverInfo, options)`, so it can be passed through
  `createMcpHandler(factory, { serverInfo, maxToolInputElements })`.
- `GHSA-rvq5-wwqv-78pq` bearer-token handling — our auth is first-party
  (`src/lib/mcp/key.ts`, timing-safe, closed by default), reachability unknown.
Fix: `mcp-handler@2.3.0` + `@modelcontextprotocol/server@2.3.0` +
`maxToolInputElements`.

**5. `pillow@12.3.0` — 35 advisories**, patched in **13.0.0** (major). Not
imported by first-party code; comes in through `llama-index-readers-file`. The
worker only ingests PDFs, so image decodes are limited to what llama-index does
internally — ranked below pypdf for that reason, not because the count is small.

**6. `nltk@3.10.0` — 35 advisories**, patched **3.10.4**. Transitive via
`llama-index-core` sentence splitting; most items are corpus-reader features
(`IPIPANCorpusReader` symlink read) this service never instantiates.

### P3 — toolchain / build-time only, no runtime exposure

- `brace-expansion` (5 advisories) — via `minimatch` in eslint, typescript-eslint,
  and the `typeorm` CLI. Not in a request path.
- `source-map-js@1.2.1` — via `postcss` / `@tailwindcss/node`. Build only.
- `baseline-browser-mapping@2.10.40` — via `browserslist` / `next`. Build only.
- The 41-high dev half of `npm audit` (jest tree, `js-yaml@3`, `braces`,
  `micromatch`, `fast-glob`, `argparse`, `sprintf-js`) — local/CI tooling.
- `csv-parse@6.2.1` proto pollution via `columns` (`GHSA-8cw4-87c7-c6xx`,
  patched 7.0.2, major). Used with `columns: true` in
  `evaluation/diagnostics/*` — but only against the repo's own
  `search-service/data/documents.csv`, so the "attacker-controlled columns" premise
  does not hold.

### P4 — patch-level, transitive, low

`aiohttp 3.14.3→3.14.5`, `urllib3 2.7.0→2.8.0`, `multidict 6.7.1→6.9.1`,
`banks 2.4.5→2.5.1`, `tinytag 2.2.1→2.3.2`, `certifi 2026.7.22→2026.10.19`
(the pinned bundle still trusts `emSign ECC Root CA - G3`, which current certifi
drops). All the same day's `requirements.txt` regeneration.

## Non-advisory findings

**N1. CI runs an unpinned third-party action with repo secrets.**
`.github/workflows/pr-agent.yml:96` uses `the-pr-agent/pr-agent@main` on
`pull_request_target` with `OPENROUTER_API_KEY` and `pull-requests: write`. A
mutable branch ref means upstream `main` runs unreviewed, immediately, with those
secrets. The file's own comment acknowledges it. Pin to a SHA:
`the-pr-agent/pr-agent@b1e75b56580b33f048ce9f6cb8bd5e1050097f24` (upstream
`main` at 2026-10-22T16:11Z) and let Dependabot bump it monthly.

**N2. Both Dockerfiles disable transport integrity checks.**
Root `Dockerfile`:
`apk add --no-cache --no-check-certificate curl aws-cli ca-certificates` turns off
apk signature verification, and
`curl -fsSk https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`
turns off TLS verification for the RDS CA bundle — the artifact that decides which
database certificates the app trusts. An on-path attacker can substitute a rogue
bundle and intercept RDS TLS. Drop `--no-check-certificate` and `-k`; if apk
signature checks were failing in the build, that is the thing to fix.

**N3. Base images float; nothing re-scans them.**
`node:24-alpine`, `python:3.12-slim` are tags, not digests. ECR has
`scan_on_push = true` for both repos (`terraform/infrastructure/ecr.tf:10,69`)
but there is no scheduled re-scan, no CI gate on findings, and no periodic
rebuild, so a base-image CVE that lands after a push is invisible until the next
deploy. Digest-pin both images and add a scheduled rebuild/scan.

**N4. Dependabot cannot close the P1 major bumps.**
`.github/dependabot.yml` ignores `semver-major` on every ecosystem, monthly
cadence. That is fine for noise, but `pillow` and `csv-parse` only have major
fixes, so those advisories stay open indefinitely unless someone opts in.

## Fix tranches

1. **Tranche A (this branch, same day):** `next@16.4.2` (pulls `sharp@0.35.5`),
   `mcp-handler@2.3.0` + `@modelcontextprotocol/server@2.3.0` +
   `maxToolInputElements`, regenerate `requirements.txt` (clears pypdf, aiohttp,
   urllib3, multidict, banks, tinytag, certifi, nltk), pin the PR-Agent action to
   a SHA, drop `-k`/`--no-check-certificate`. Verify with `npm run lint`,
   `npm test`, `npx next build --webpack`, `npm run test:python`.
2. **Tranche B (separate PR):** `pillow@13`, `csv-parse@7`, and npm `overrides`
   for the transitive `@tiptap/core`, `prosemirror-view`, `source-map-js`,
   `brace-expansion`, `baseline-browser-mapping` bumps — these need per-package
   verification (design-system pin, postcss/minimatch chains).
3. **Tranche C (infra):** digest-pinned base images, scheduled ECR re-scan,
   Dependabot exception for security-relevant majors.

## Reproduction

`.sweep/` in the worktree holds the raw `npm audit` and `pip-audit` JSON used
above (untracked; regenerate with the commands in [Method](#method)).
