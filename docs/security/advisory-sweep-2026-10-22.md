# Advisory sweep — 2026-10-22

Proactive CVE/advisory pass over everything this repo pins (bugfix-evidence Gate 3),
plus the remediation for every finding it raised. See
[What this branch changed](#what-this-branch-changed) for the diff and the evidence.

Branch: `fix/advisory-sweep` (off `qa` @ `154c38d`).

## Method

| Rung | Command |
|---|---|
| npm, all deps | `npm audit --json` (npm 11.19.0) → `.sweep/npm-audit-all.json` |
| npm, runtime only | `npm audit --omit=dev --json` (npm 11.19.0) → `.sweep/npm-audit-prod.json` |
| pip, deploy pins | `docker run --rm -v "$PWD:/w" -w /w python:3.12-slim sh -c 'pip install pip-audit && pip-audit -f json -r requirements.txt'` (pip-audit 2.10.1, run in `search-service/`) → `.sweep/pip-audit.json` |
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

**N1. CI ran an unpinned third-party action with repo secrets.**
`.github/workflows/pr-agent.yml` used `the-pr-agent/pr-agent@main` on
`pull_request_target` with `OPENROUTER_API_KEY` and `pull-requests: write`. A
mutable branch ref means upstream `main` runs unreviewed, immediately, with those
secrets. The file's own comment acknowledged it. Resolved by pinning the release
tag `the-pr-agent/pr-agent@v0.48.0` — landed in #457, kept here.

A tag is still mutable, so a full commit SHA is strictly safer. That was tried in
this branch and reverted on review: Dependabot keeps tags current but its updates
for SHA-pinned actions are unreliable (dependabot-core#14716, #7912), and leaving
the upgrades with Dependabot is the repo owner's call.

**This is an accepted risk, not a closed one.** Whoever can move the upstream
`v0.48.0` tag can change the code that runs here with `OPENROUTER_API_KEY` and
`pull-requests: write`, with no diff in this repo. Accepted on PR #459 on
2026-10-22 in exchange for Dependabot-managed upgrades. Two things would restore
an immutable pin later, if the trade ever stops looking worth it: pin
`981344be2755e303df501e18e3f60b848a188a80 # v0.48.0` and bump it by hand, or keep
the tag and check it still resolves to that commit on a schedule.

**N2. The root Dockerfile disables transport integrity checks.**
`Dockerfile`:
`apk add --no-cache --no-check-certificate curl aws-cli ca-certificates` turns off
apk signature verification, and
`curl -fsSk https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`
turns off TLS verification for the RDS CA bundle — the artifact that decides which
database certificates the app trusts. An on-path attacker can substitute a rogue
bundle and intercept RDS TLS. Drop `--no-check-certificate` and `-k`; if apk
signature checks were failing in the build, that is the thing to fix.

`search-service/Dockerfile` has neither flag — it installs from Debian packages and
fetches nothing over the network with verification disabled.

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

## What this branch changed

| Finding | Change | Verified by |
|---|---|---|
| P1 `next` (critical Image Optimization RCE + SSRF + SSG/ISR cache poisoning + Server Action DoS) | `next` 16.3.6 → **16.4.2**, `eslint-config-next` + `@next/eslint-plugin-next` moved with it | `npm audit --omit=dev` clean, `npx next build --webpack` green |
| P1 `sharp` librsvg RCE | 0.35.4 → **0.35.5** (via override; it is an optional dep of `next`) | `npm ls sharp` |
| P1 `pypdf` (24 advisories, parsed on the ingestion path) | 6.14.2 → **6.21.2** | `pip-audit` clean, pytest |
| P2 MCP (`GHSA-46jr-4wx8-v453` etc.) | `mcp-handler` 2.2.0 → **2.3.0**, `@modelcontextprotocol/server` 2.2.0 → **2.3.1**, plus `maxToolInputElements: 1_000` on the handler (`route.ts`) — the upgrade alone does not enable the guard | `mcp-route.test.ts` drives 900 elements (reaches the service) and 1001 (refused, no fetch). Fails with the option removed, passes with it. |
| P2 `pillow` (35), `nltk` (35) | **13.0.0**, **3.10.4** | `pip-audit` clean |
| P3 `brace-expansion` (6), `source-map-js`, `baseline-browser-mapping`, `browserslist` | npm `overrides` + `npm update`; `brace-expansion` floored per major line (1.x/2.x/5.x — they are API-incompatible) | `npm audit`, lint, 92 jest suites |
| P3 `csv-parse` | 6.2.1 → **7.0.3** (the vulnerable `columns` path is what `evaluation/diagnostics/*` uses) | lint |
| P4 `aiohttp`, `urllib3`, `multidict`, `banks`, `tinytag`, `certifi` | security floors in `requirements.in`, pinned by `compile-requirements.sh` | `pip-audit` clean |
| N1 unpinned PR-Agent action | `@main` → `@v0.48.0` (a release tag; Dependabot keeps it current) | YAML diff |
| N2 Dockerfile transport integrity | dropped `apk --no-check-certificate` and `curl -k` | ran both commands in `node:24-alpine`: apk verifies, bundle downloads 114 certs |

Two structural fixes fell out of the above, both worth keeping:

- `requirements-dev.in` now pulls `-r requirements.in` **and** `-c requirements.txt`.
  The two lockfiles are compiled independently, so they could pin different
  versions of one package — which is exactly what happened mid-remediation
  (`urllib3` 2.8.0 vs 2.7.0, then `anyio` 4.14.2 vs 4.15.1) and what CI's second
  `pip install` rejects. Constraints make that impossible.
- `nltk` 3.10.4 added a check that refuses to read NLTK data from a directory
  writable by anyone but its owner, and GitHub's setup-python toolcache makes
  site-packages group-writable — so llama-index's bundled `nltk_cache` (punkt,
  stopwords) was rejected and `SentenceSplitter` raised `LookupError`. `pr-check.yml`
  now makes that directory private before the suite runs. The deployed image is
  unaffected (pip installs as root, site-packages is 0755); that was checked by
  running the same tests as uid 1000 against a root install.
- The floors in `requirements.in` are named, commented, transitive-only deps.
  `pip-compile` keeps whatever the previous resolution chose, so an advisory in a
  transitive dep only moves if the `.in` names it; the comment says when to drop
  each one.

## Residual (not fixed, with reasons)

| Left open | Why |
|---|---|
| `js-yaml@3.15.2` (dev, `@istanbuljs/load-nyc-config` → istanbul → jest coverage) | No 3.x fix exists — the advisory's only patched line is 4.x, and `load-nyc-config@1.1.0` (latest) requires `^3.13.1`. Dev-only, parses the repo's own config. |
| `braces` / `micromatch` / `fast-glob` (dev, via `@next/eslint-plugin-next`) | `GHSA-vfj7-8cjw-p6xm` covers `*` — no patched version was published. Has to wait upstream. With the `js-yaml@3` chain these two advisories account for all 38 remaining entries and every "high". |
| `sprintf-js` (dev, via `argparse` ← `js-yaml@3` ← istanbul) | Same root as the `js-yaml@3` row; goes away when that one can. |
| jest 29 → 30 | Considered and **reverted**. It fixes no advisory of its own: the jest tree was flagged only through `js-yaml@3` (which jest 30 still pulls) and `braces`. It also upgrades jsdom 20 → 26, where `window.location` is spec-compliantly unforgeable, and two admin suites that stub it to assert a 401 redirect fail. Making them pass means either weakening the assertions or moving 17 `window.location.href` call sites onto a mockable seam — neither belongs in a security sweep. |
| N3 base-image digests / re-scan | Digest-pinning trades automatic base updates for reproducibility and does nothing about images already pushed; scheduled re-scan is ECR **registry-level** (account-wide blast radius), not a per-repo Terraform change. Needs an infra decision. |
| N4 Dependabot `semver-major` ignore | Editing that file re-runs every ecosystem immediately (its own header warns: 19 PRs last time), and Dependabot has no per-dependency un-ignore. Needs a deliberate change, not a drive-by. |

## Verification (run on this branch, 2026-10-22)

| Check | Result |
|---|---|
| `npm audit --omit=dev` | **0** (was 9: 1 critical, 6 high, 2 moderate) |
| `npm audit` | 38 left (33 high, 5 moderate), every one dev toolchain, all propagated from two advisories with no published fix (see Residual) |
| `pip-audit -r requirements.txt -r requirements-dev.txt` (in `python:3.12-slim`) | **No known vulnerabilities found** (was 110 across 9 packages) |
| `npm run lint` | 0 errors, 18 pre-existing warnings |
| `npm test` | 92 suites, 1031 tests passed |
| `npx next build --webpack` | green |
| `pytest tests/` (in `python:3.12-slim`) | 445 passed, 213 skipped, 4 failed — all four are `test_probe_rerank_isolation.py` requiring `DATABASE_URL` from `scripts/with-remote-env.sh qa` (a guard, not a version error) |
| apk + RDS-bundle download in `node:24-alpine` | both succeed with verification enabled |

One claim in this doc is a check rather than a recollection. It was run on
**2026-10-22** and the result is recorded here.

**The MCP guard is load-bearing.** `npx jest src/__tests__/mcp-route.test.ts`
covers it: the case sends 900 elements (the search runs, once) and 1001 (refused
with the SDK's own `arguments contain more than the maximum of 1000 elements` and
`isError: true`, nothing searched). Deleting the `maxToolInputElements:` line from
`src/app/api/mcp/route.ts` makes that case fail — `1 failed, 10 passed, 11 total`
on 2026-10-22. That is why the line is there, and why the test exists: without
either, the mitigation is a silent no-op.

Not run here: the DB-backed suites (`npm run test:db`), the cite/QA evals, and a
container build of either image end to end — all need the local stack or AWS.

## Deferred

`pillow@13` (major), `csv-parse@7` (major), the npm `overrides` and the
`@tiptap` family all landed here, so the only deliberately deferred items are the
infra ones in [Residual](#residual-not-fixed-with-reasons).

## Reproduction

The commands in [Method](#method) reproduce every number here: the audit
toolchain versions are named, the advisory detail was read on **2026-10-22**, and
the packages were pinned in `package-lock.json`, `requirements.txt` and the two
Dockerfiles, so a later run differs only where advisories or pins moved. Raw JSON
was kept in `.sweep/` while working and is not committed — the summary tables above
are the record, and they are what a reviewer can diff against a fresh run.
