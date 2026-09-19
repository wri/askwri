# Answer Contract (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make answer-mode citations real (model-emitted, per sentence), expose the synthesis knobs the eval will sweep, route synthesis through a provider-agnostic client, and lock the gateway to an allowlist — with production behaviour otherwise unchanged.

**Architecture:** A small chat-completions client (`src/lib/llm/chat-completions.ts`) replaces the two hardcoded OpenAI fetches. The answer route gains optional request knobs, a v2 prompt whose sentences carry `cites`, server-side validation of cites against `passages_sent`, and echoes both in the response. The UI derives inline citations, the cited-document count, and the "Directly cited" list from those cites through pure helpers in `src/app/components/AnswerMode/citations.ts`. The gateway replaces its body spread with an allowlist of forwardable `QueryRequest` fields.

**Tech Stack:** Next.js 16 App Router routes (`runtime='nodejs'`), React 19 + Chakra + `@worldresources/wri-design-systems`, Jest (jsdom default; route tests use `@jest-environment node`), TypeScript, Prettier + ESLint 9.

**Spec:** `docs/superpowers/specs/2026-09-03-answer-eval-overhaul-design.md` §5.1, §5.2, §5.4, §6 (route / gateway / UI tests).

## Global Constraints

- Production callers (`AIResearchModal`, `results/page.tsx`) send no new knobs; with no knobs the route sends the same passage count (8 for gpt-5*, else 6) and truncation (400 / 350 chars) as today.
- Cite-mode gateway behaviour byte-identical: every field `chatCiteLlamaIndex` sends today stays forwardable.
- No Co-Authored-By trailers in commit messages (user rule).
- `npm run lint`, `npm run format:check`, `npm test`, and `npx tsc --noEmit` must pass before the PR.
- Env names: `OPENAI_BASE_URL` (default `https://api.openai.com/v1`), `OPENAI_API_KEY`, `LUNAROUTE_BASE_URL`, `LUNAROUTE_API_KEY`. Nothing else new.
- Work happens in the worktree `.claude/worktrees/answer-evals-rework` on branch `worktree-answer-evals-rework`.

---

## File map

| File | Responsibility |
|---|---|
| Create `src/lib/llm/chat-completions.ts` | Resolve provider (model, base URL, key) and POST a chat completion. Only place that knows about provider URLs. |
| Create `src/lib/llm/__tests__/chat-completions.test.ts` | Provider resolution + request shape. |
| Modify `src/app/api/answer/route.ts` | Knobs, v2 prompt with cites, validation, `passages_sent`, `likely_off_topic`. |
| Create `src/__tests__/answer-route.test.ts` | Contract tests for the route (node env, mocked fetch). |
| Modify `src/app/api/llamaindex/route.ts:46-115` | Allowlist replaces `...options`. |
| Create `src/__tests__/llamaindex-route-allowlist.test.ts` | Allowlist behaviour. |
| Modify `src/lib/llamaindex-client.ts` | Delete `chatAnswerLlamaIndex`. |
| Modify `src/__tests__/answer-mode-cite-docs.test.ts:22-34` | Payload mirror reflects the modal, not the deleted client. |
| Create `src/app/components/AnswerMode/citations.ts` | Pure helpers: inline from cites, cited-doc count, citation ordering. |
| Create `src/app/components/AnswerMode/__tests__/citations.test.ts` | Helper tests. |
| Modify `src/app/components/AnswerMode/types.ts` | `PassageSent`, `InlineRef`, `AnswerResult.cites`, `SupportingCitationsProps.inline`. |
| Modify `src/app/components/AnswerMode/AIResearchModal.tsx:110-330` | Send `likely_off_topic`; build inline from cites; drop slice block and label computation. |
| Modify `src/app/components/AnswerMode/AnswerPanel.tsx:44-46, 175-280` | N = cited docs; marker click resolves the cited passage's index. |
| Modify `src/app/components/AnswerMode/SupportingCitations.tsx:62-72, 236-330` | Order: cited passages first (citation order), then rest by relevance; labels from inline. |
| Create `src/__tests__/answer-panel-citations.test.tsx` | Rendered N and marker click index. |
| Modify `.env.example` | Document the four env names. |

---

### Task 1: Chat-completions client

**Files:**
- Create: `src/lib/llm/chat-completions.ts`
- Create: `src/lib/llm/__tests__/chat-completions.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces:
  ```ts
  export interface ProviderOverride { model?: string; base_url?: string }
  export interface ResolvedProvider { model: string; baseUrl: string; apiKey: string | undefined; isGpt5: boolean }
  export function resolveProvider(defaultModel: string, override?: ProviderOverride): ResolvedProvider
  export interface ChatResult { status: number; ok: boolean; text: string; json: any }
  export function chatCompletion(p: { baseUrl: string; apiKey: string; body: Record<string, unknown> }): Promise<ChatResult>
  ```

- [ ] **Step 1: Write the failing tests**

`src/lib/llm/__tests__/chat-completions.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { resolveProvider, chatCompletion } from '../chat-completions'

const ENV = { ...process.env }
afterEach(() => {
  process.env = { ...ENV }
  jest.restoreAllMocks()
})

describe('resolveProvider', () => {
  it('defaults to OpenAI with the default model', () => {
    delete process.env.OPENAI_BASE_URL
    process.env.OPENAI_API_KEY = 'sk-openai'
    const p = resolveProvider('gpt-5.4')
    expect(p).toEqual({
      model: 'gpt-5.4',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      isGpt5: true,
    })
  })

  it('honours OPENAI_BASE_URL and strips a trailing slash', () => {
    process.env.OPENAI_BASE_URL = 'https://proxy.example/v1/'
    process.env.OPENAI_API_KEY = 'sk-openai'
    expect(resolveProvider('gpt-5.4').baseUrl).toBe('https://proxy.example/v1')
  })

  it('uses the lunaroute key when the override base_url is lunaroute', () => {
    process.env.OPENAI_API_KEY = 'sk-openai'
    process.env.LUNAROUTE_BASE_URL = 'https://gw.lunaroute.com/v1'
    process.env.LUNAROUTE_API_KEY = 'lr-key'
    const p = resolveProvider('gpt-5.4', {
      model: 'glm-5.2-vision',
      base_url: 'https://gw.lunaroute.com/v1/',
    })
    expect(p).toEqual({
      model: 'glm-5.2-vision',
      baseUrl: 'https://gw.lunaroute.com/v1',
      apiKey: 'lr-key',
      isGpt5: false,
    })
  })

  it('an override base_url that is not lunaroute keeps the OpenAI key', () => {
    process.env.OPENAI_API_KEY = 'sk-openai'
    process.env.LUNAROUTE_BASE_URL = 'https://gw.lunaroute.com/v1'
    process.env.LUNAROUTE_API_KEY = 'lr-key'
    const p = resolveProvider('gpt-5.4', { base_url: 'https://other.example/v1' })
    expect(p.apiKey).toBe('sk-openai')
    expect(p.baseUrl).toBe('https://other.example/v1')
  })
})

describe('chatCompletion', () => {
  it('POSTs to <baseUrl>/chat/completions with bearer auth and returns parsed json', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
          status: 200,
        }),
      )
    const r = await chatCompletion({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      body: { model: 'gpt-5.4', messages: [] },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer sk-x' }),
        body: JSON.stringify({ model: 'gpt-5.4', messages: [] }),
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
    expect(r.json.choices[0].message.content).toBe('hi')
  })

  it('returns {raw} json when the body is not JSON', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }))
    const r = await chatCompletion({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      body: {},
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(502)
    expect(r.json).toEqual({ raw: '<html>bad gateway</html>' })
    expect(r.text).toBe('<html>bad gateway</html>')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/lib/llm/__tests__/chat-completions.test.ts`
Expected: FAIL — `Cannot find module '../chat-completions'`.

- [ ] **Step 3: Write the implementation**

`src/lib/llm/chat-completions.ts`:

```ts
/**
 * One OpenAI-compatible chat-completions client for the app tier.
 *
 * Every LLM call that used to hardcode https://api.openai.com goes through
 * here, so a different provider (lunaroute for GLM, a proxy, a local server)
 * is a base-URL change, not a code change. The eval harness's synthesis
 * candidates depend on this: the same route, the same prompt, a different
 * `base_url` + `model`.
 */

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

export interface ProviderOverride {
  model?: string
  base_url?: string
}

export interface ResolvedProvider {
  model: string
  baseUrl: string
  apiKey: string | undefined
  /** gpt-5* takes max_completion_tokens and no temperature. */
  isGpt5: boolean
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Pick model, base URL and key. The key follows the base URL: a base URL
 * equal to LUNAROUTE_BASE_URL uses LUNAROUTE_API_KEY; anything else uses
 * OPENAI_API_KEY (proxies that front OpenAI keep the OpenAI key).
 */
export function resolveProvider(
  defaultModel: string,
  override: ProviderOverride = {},
): ResolvedProvider {
  const model = (override.model ?? defaultModel).trim()
  const baseUrl = stripSlash(
    override.base_url?.trim() ||
      process.env.OPENAI_BASE_URL?.trim() ||
      OPENAI_DEFAULT_BASE_URL,
  )
  const lunaroute = process.env.LUNAROUTE_BASE_URL?.trim()
  const apiKey =
    lunaroute && stripSlash(lunaroute) === baseUrl
      ? process.env.LUNAROUTE_API_KEY?.trim()
      : process.env.OPENAI_API_KEY?.trim()
  return { model, baseUrl, apiKey, isGpt5: /^gpt-5/i.test(model) }
}

export interface ChatResult {
  status: number
  ok: boolean
  text: string
  json: any
}

export async function chatCompletion(p: {
  baseUrl: string
  apiKey: string
  body: Record<string, unknown>
}): Promise<ChatResult> {
  const r = await fetch(`${p.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${p.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(p.body),
  })
  const text = await r.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  return { status: r.status, ok: r.ok, text, json }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/lib/llm/__tests__/chat-completions.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Document the env names**

Append to `.env.example` after the existing `OPENAI_API_KEY` line:

```
# Optional: OpenAI-compatible base URL for all app-tier LLM calls (default https://api.openai.com/v1)
OPENAI_BASE_URL=
# Optional: second provider for eval synthesis candidates (glm via lunaroute).
# The answer route uses LUNAROUTE_API_KEY when a request's base_url equals LUNAROUTE_BASE_URL.
LUNAROUTE_BASE_URL=https://gw.lunaroute.com/v1
LUNAROUTE_API_KEY=
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/chat-completions.ts src/lib/llm/__tests__/chat-completions.test.ts .env.example
git commit -m "feat(llm): provider-agnostic chat-completions client (base URL + key resolution)"
```

---

### Task 2: Answer route — knobs, provider, `passages_sent`

Make the synthesis inputs explicit and overridable, without changing what production sends. Prompt content stays v1 in this task; cites arrive in Task 3.

**Files:**
- Modify: `src/app/api/answer/route.ts` (lines 11-19 constants; 248-262 nano fetch; 296-340 request parsing/docList; 400-412 maxDocs; 425-466 prompt + fetch; 582-606 response)
- Create: `src/__tests__/answer-route.test.ts`

**Interfaces:**
- Consumes: `resolveProvider`, `chatCompletion` from Task 1.
- Produces (request, all optional): `model: string`, `base_url: string`, `max_passages: number`, `passage_chars: number`, `prompt_version: 'v1' | 'v2'`, `likely_off_topic: boolean`.
- Produces (response): `passages_sent: PassageSent[]` where
  ```ts
  interface PassageSent { id: number; doc_id: string; chunk_id: string; page: number; text: string }
  ```
  and `debug.knobs: { model, base_url, max_passages, passage_chars, prompt_version, likely_off_topic }`.
- Exports for tests: `export function resolveSynthesisConfig(body: any): SynthesisConfig` and `export const SYS_V1: string`.

- [ ] **Step 1: Write the failing tests**

`src/__tests__/answer-route.test.ts`:

```ts
/**
 * @jest-environment node
 *
 * Contract tests for POST /api/answer. The provider is a mocked global fetch
 * so every test asserts on exactly what would have been sent to the model.
 */
import { NextRequest } from 'next/server'

const ENV = { ...process.env }
let fetchMock: jest.SpyInstance

function modelReply(content: string, status = 200) {
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }),
    { status },
  )
}

function docs(n: number, snippetLen = 1000) {
  return Array.from({ length: n }, (_, i) => ({
    doc_id: `doc_${i + 1}`,
    title: `Title ${i + 1}`,
    year: 2020 + i,
    kps: [
      {
        kp_relevance: 1 - i * 0.01,
        snippet: `S${i + 1} `.repeat(snippetLen / 3).slice(0, snippetLen),
        page: i + 1,
        passage_id: `doc_${i + 1}_chunk_${i}`,
        citation_targets: [],
      },
    ],
  }))
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/answer/route')
  const res = await POST(
    new NextRequest('http://localhost/api/answer', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  )
  return res.json()
}

function sentBody(): any {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
  return JSON.parse(call[1].body)
}

beforeEach(() => {
  jest.resetModules()
  process.env = { ...ENV, OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-5.4' }
  delete process.env.OPENAI_BASE_URL
  delete process.env.USE_NANO_FILTER
  fetchMock = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(
      modelReply(JSON.stringify({ sentences: ['A.', 'B.'], source_relevance: [] })),
    )
})
afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...ENV }
})

describe('POST /api/answer — defaults reproduce current behaviour', () => {
  it('gpt-5 default: 8 passages, 400 chars, max_completion_tokens, no temperature', async () => {
    const out = await post({ query: 'q', docs: docs(15), prompt_version: 'v1' })
    expect(out.ok).toBe(true)
    expect(out.passages_sent).toHaveLength(8)
    for (const p of out.passages_sent) expect(p.text.length).toBeLessThanOrEqual(400)
    const body = sentBody()
    expect(body.model).toBe('gpt-5.4')
    expect(body.max_completion_tokens).toBe(2000)
    expect(body.temperature).toBeUndefined()
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('non-gpt-5 default: 6 passages, 350 chars, max_tokens + temperature', async () => {
    process.env.OPENAI_MODEL = 'gpt-4o-mini'
    const out = await post({ query: 'q', docs: docs(15), prompt_version: 'v1' })
    expect(out.passages_sent).toHaveLength(6)
    for (const p of out.passages_sent) expect(p.text.length).toBeLessThanOrEqual(350)
    const body = sentBody()
    expect(body.max_tokens).toBe(1500)
    expect(body.temperature).toBe(0.3)
  })

  it('v1 prompt is the legacy system prompt and the legacy user layout', async () => {
    const { SYS_V1 } = await import('@/app/api/answer/route')
    await post({ query: 'What?', docs: docs(2), prompt_version: 'v1' })
    const body = sentBody()
    expect(body.messages[0]).toEqual({ role: 'system', content: SYS_V1 })
    expect(body.messages[1].content).toContain('Question: What?')
    expect(body.messages[1].content).toContain('[1] "Title 1" (2020)\n   Key finding: ')
    expect(body.messages[1].content).toContain(
      'Task: Evaluate each source\'s relevance, then write exactly 2-3 clear sentences',
    )
  })

  it('passages_sent carries id, doc_id, chunk_id, page and the exact text sent', async () => {
    const out = await post({ query: 'q', docs: docs(2, 50), prompt_version: 'v1' })
    expect(out.passages_sent[0]).toEqual({
      id: 1,
      doc_id: 'doc_1',
      chunk_id: 'doc_1_chunk_0',
      page: 1,
      text: expect.any(String),
    })
    expect(sentBody().messages[1].content).toContain(out.passages_sent[0].text)
  })
})

describe('POST /api/answer — knobs', () => {
  it('max_passages and passage_chars override the defaults', async () => {
    const out = await post({
      query: 'q',
      docs: docs(15),
      max_passages: 12,
      passage_chars: 800,
    })
    expect(out.passages_sent).toHaveLength(12)
    expect(Math.max(...out.passages_sent.map((p: any) => p.text.length))).toBe(800)
    expect(out.debug.knobs).toMatchObject({ max_passages: 12, passage_chars: 800 })
  })

  it('max_passages is capped at 15', async () => {
    const out = await post({ query: 'q', docs: docs(20), max_passages: 40 })
    expect(out.passages_sent).toHaveLength(15)
  })

  it('model + base_url reach the provider, and the lunaroute key is used', async () => {
    process.env.LUNAROUTE_BASE_URL = 'https://gw.lunaroute.com/v1'
    process.env.LUNAROUTE_API_KEY = 'lr-key'
    await post({
      query: 'q',
      docs: docs(3),
      model: 'glm-5.2-vision',
      base_url: 'https://gw.lunaroute.com/v1',
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://gw.lunaroute.com/v1/chat/completions')
    expect(init.headers.authorization).toBe('Bearer lr-key')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('glm-5.2-vision')
    expect(body.max_tokens).toBeDefined() // non-gpt-5 branch
  })

  it('a missing key for the resolved provider returns the fallback, no call', async () => {
    delete process.env.OPENAI_API_KEY
    const out = await post({ query: 'q', docs: docs(3) })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out.debug.fallbackReason).toBe('no_api_key')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/answer-route.test.ts`
Expected: FAIL — `passages_sent` undefined, `SYS_V1` not exported, knobs ignored.

- [ ] **Step 3: Replace the module-level constants with `resolveSynthesisConfig`**

In `src/app/api/answer/route.ts`, replace lines 11-19 (`MODEL` … `USE_NANO_FILTER`) with:

```ts
import { chatCompletion, resolveProvider } from '@/lib/llm/chat-completions'

const DEFAULT_MODEL = (process.env.OPENAI_MODEL ?? 'gpt-5.4').trim()
const NANO_MODEL = (process.env.OPENAI_MODEL_NANO ?? 'gpt-5.4-nano').trim()
const USE_NANO_FILTER =
  (process.env.USE_NANO_FILTER ?? 'false').toLowerCase() === 'true'
const MAX_PASSAGES_CAP = 15

export type PromptVersion = 'v1' | 'v2'

export interface SynthesisConfig {
  model: string
  baseUrl: string
  apiKey: string | undefined
  isGpt5: boolean
  maxTokens: number
  temperature: number
  maxPassages: number
  passageChars: number
  promptVersion: PromptVersion
  likelyOffTopic: boolean
}

/**
 * Everything that shapes one synthesis call, from env defaults plus optional
 * request knobs. With no knobs this reproduces the pre-2026-09 behaviour
 * exactly (gpt-5*: 8 passages × 400 chars; else 6 × 350). The knobs exist for
 * the eval harness's sweeps; production callers never send them.
 */
export function resolveSynthesisConfig(body: any): SynthesisConfig {
  const provider = resolveProvider(DEFAULT_MODEL, {
    model: typeof body?.model === 'string' ? body.model : undefined,
    base_url: typeof body?.base_url === 'string' ? body.base_url : undefined,
  })
  const defaultMax = provider.isGpt5 ? 2000 : 1500
  const envMax = Number(process.env.OPENAI_MAX_TOKENS || defaultMax)
  const maxTokens = provider.isGpt5 ? Math.max(2000, envMax) : envMax
  const temperature = Number(process.env.OPENAI_TEMPERATURE ?? 0.3)
  const int = (v: unknown, fallback: number, cap: number) =>
    Number.isInteger(v) && (v as number) > 0
      ? Math.min(v as number, cap)
      : fallback
  return {
    ...provider,
    maxTokens,
    temperature,
    maxPassages: int(body?.max_passages, provider.isGpt5 ? 8 : 6, MAX_PASSAGES_CAP),
    passageChars: int(body?.passage_chars, provider.isGpt5 ? 400 : 350, 20_000),
    promptVersion: body?.prompt_version === 'v1' ? 'v1' : 'v2',
    likelyOffTopic: body?.likely_off_topic === true,
  }
}
```

Delete the `[Answer Route INIT]` console.log block (lines 36-48). Rename the existing `SYS` const to `SYS_V1` and export it: `export const SYS_V1 = IS_GPT5 ? … : …` becomes a plain string — keep the gpt-5 variant (the two variants differ only in wording; the gpt-5 one is what production has run since the default became gpt-5.4):

```ts
export const SYS_V1 = `
Synthesize a concise answer from the provided documents. Write exactly 2-3 clear sentences.
… (the existing gpt-5 branch text, verbatim) …
`.trim()
```

Delete the non-gpt-5 branch of the old `SYS` ternary.

- [ ] **Step 4: Route the nano filter through the client**

In `runNanoFilter`, change the signature to `(query, docs, provider: { baseUrl: string; apiKey: string })` and replace the `fetch('https://api.openai.com/v1/chat/completions', …)` block (lines 248-262) with:

```ts
    const r = await chatCompletion({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      body,
    })

    if (!r.ok) {
      console.error(`[Nano Filter] API error: ${r.status}`)
      return null
    }

    const content = r.json.choices?.[0]?.message?.content || ''
```

(and delete the now-unused `const data = await r.json()` line).

- [ ] **Step 5: Use the config in `POST`**

Replace lines 296-340 (from `const key = process.env.OPENAI_API_KEY?.trim()` through the `docList` map) with:

```ts
    const cfg = resolveSynthesisConfig(reqBody)
    debugInfo.knobs = {
      model: cfg.model,
      base_url: cfg.baseUrl,
      max_passages: cfg.maxPassages,
      passage_chars: cfg.passageChars,
      prompt_version: cfg.promptVersion,
      likely_off_topic: cfg.likelyOffTopic,
    }

    const key = cfg.apiKey
    if (!key) {
      console.log('[Answer Route] No API key, using fallback')
      debugInfo.fallbackReason = 'no_api_key'
      return NextResponse.json({
        ok: true,
        synthesis: synthFallback(query, docs),
        passages_sent: [],
        debug: debugInfo,
      })
    }

    // Build doc list from all incoming docs (the gateway returns at most 15)
    const allDocs = (Array.isArray(docs) ? docs : []).slice(0, MAX_PASSAGES_CAP)

    const docList = allDocs.map((d: any, idx: number) => ({
      id: idx + 1,
      title: d.title || 'Untitled',
      authors: d.authors,
      year: d.year,
      doc_id: d.doc_id || '',
      chunk_id: String(d.kps?.[0]?.passage_id ?? ''),
      page: Number(d.kps?.[0]?.page ?? 1),
      key_finding: String(d.kps?.[0]?.snippet ?? d.content ?? '').slice(
        0,
        cfg.passageChars,
      ),
      relevance: d.kps?.[0]?.kp_relevance || d.score || 0,
    }))
```

Pass the provider into the nano filter call: `runNanoFilter(query, …, { baseUrl: cfg.baseUrl, apiKey: key })`.

Replace both `const maxDocs = IS_GPT5 ? 8 : 6` lines (nano branch and else branch) with `const maxDocs = cfg.maxPassages`.

After `filteredDocs` is final (just before `debugInfo.docListCreated = …`), add:

```ts
    const passagesSent = filteredDocs.map((d) => ({
      id: d.id,
      doc_id: d.doc_id,
      chunk_id: d.chunk_id,
      page: d.page,
      text: d.key_finding,
    }))
```

Replace the `messages` / `apiBody` / `fetch` block (lines 442-475, from `const messages = [` through `json = { raw: text }` `}`) with:

```ts
    const messages = [
      { role: 'system', content: SYS_V1 },
      { role: 'user', content: userContent },
    ]

    const used = cfg.isGpt5
      ? 'chat.max_completion_tokens.no_temp'
      : 'chat.max_tokens.with_temp'
    const apiBody: any = {
      model: cfg.model,
      messages,
      ...(cfg.isGpt5
        ? { max_completion_tokens: cfg.maxTokens }
        : { max_tokens: cfg.maxTokens, temperature: cfg.temperature }),
    }

    debugInfo.apiCall = {
      model: cfg.model,
      maxTokens: cfg.maxTokens,
      temperature: cfg.isGpt5 ? 'omitted' : cfg.temperature,
      messageCount: messages.length,
      userContentLength: userContent.length,
    }

    const r = await chatCompletion({ baseUrl: cfg.baseUrl, apiKey: key, body: apiBody })
    const json: any = r.json
```

Delete the two `console.log('[Answer Route] Token config: …')` lines that reference `DEFAULT_MAX` / `MAX`. Every later `IS_GPT5` reference in `POST` becomes `cfg.isGpt5`; every `MODEL` becomes `cfg.model`.

In the two early-return responses inside `POST` (nano `all_weak`, and the `api_error` fallback) add `passages_sent: passagesSent` (for the nano branch use `passages_sent: []` since nothing was sent). In the final success response add `passages_sent: passagesSent`:

```ts
    return NextResponse.json({
      ok: true,
      synthesis,
      passages_sent: passagesSent,
      debug: debugInfo,
    })
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx jest src/__tests__/answer-route.test.ts src/lib/llm`
Expected: PASS. Then `npx tsc --noEmit` — expect no errors in `route.ts` (the file has `/* eslint-disable */`, but types must still check).

- [ ] **Step 7: Commit**

```bash
git add src/app/api/answer/route.ts src/__tests__/answer-route.test.ts
git commit -m "feat(answer): request knobs, provider client, passages_sent (defaults unchanged)"
```

---

### Task 3: Answer route — v2 prompt with per-sentence cites

**Files:**
- Modify: `src/app/api/answer/route.ts` (prompt selection, parsing, response)
- Modify: `src/__tests__/answer-route.test.ts` (add a describe block)

**Interfaces:**
- Produces (response): `synthesis.sentences: string[]` (unchanged shape, so `sentences.join(' ')` consumers keep working), `synthesis.cites: number[][]` (same length as `sentences`; each entry is 1-based ids into `passages_sent`, validated, deduped, in model order), `debug.invalid_cites: number` (count dropped), `synthesis.warning === 'low_coverage'` when `likely_off_topic` was sent.
- Exports: `export const SYS_V2: string`, `export function normalizeSentences(parsed: any, validIds: Set<number>): { sentences: string[]; cites: number[][]; invalid: number }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/answer-route.test.ts`:

```ts
describe('POST /api/answer — v2 cited sentences', () => {
  it('v2 is the default prompt and asks for cites', async () => {
    const { SYS_V2 } = await import('@/app/api/answer/route')
    await post({ query: 'q', docs: docs(3) })
    expect(sentBody().messages[0]).toEqual({ role: 'system', content: SYS_V2 })
    expect(SYS_V2).toContain('"cites"')
  })

  it('returns sentences as strings plus a parallel cites array', async () => {
    fetchMock.mockResolvedValue(
      modelReply(
        JSON.stringify({
          sentences: [
            { text: 'First.', cites: [1, 3] },
            { text: 'Second.', cites: [2] },
          ],
          source_relevance: [{ id: 1, tier: 'strong' }],
        }),
      ),
    )
    const out = await post({ query: 'q', docs: docs(3) })
    expect(out.synthesis.sentences).toEqual(['First.', 'Second.'])
    expect(out.synthesis.cites).toEqual([[1, 3], [2]])
    expect(out.debug.invalid_cites).toBe(0)
  })

  it('drops cites that are not in passages_sent and counts them', async () => {
    fetchMock.mockResolvedValue(
      modelReply(
        JSON.stringify({
          sentences: [
            { text: 'First.', cites: [1, 9, 1, 0, 'x'] },
            { text: 'Second.', cites: [] },
          ],
        }),
      ),
    )
    const out = await post({ query: 'q', docs: docs(3) })
    expect(out.synthesis.cites).toEqual([[1], []])
    expect(out.debug.invalid_cites).toBe(3) // 9, 0, 'x' (duplicate 1 is deduped, not counted)
  })

  it('accepts legacy string sentences with empty cites', async () => {
    fetchMock.mockResolvedValue(modelReply(JSON.stringify({ sentences: ['A.', 'B.'] })))
    const out = await post({ query: 'q', docs: docs(3) })
    expect(out.synthesis.sentences).toEqual(['A.', 'B.'])
    expect(out.synthesis.cites).toEqual([[], []])
  })

  it('likely_off_topic forces the low_coverage warning and tells the model', async () => {
    const out = await post({ query: 'q', docs: docs(3), likely_off_topic: true })
    expect(out.synthesis.warning).toBe('low_coverage')
    expect(sentBody().messages[1].content).toContain('Coverage check:')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/answer-route.test.ts -t "v2 cited"`
Expected: FAIL — `SYS_V2` undefined, `cites` undefined.

- [ ] **Step 3: Add `SYS_V2` and `normalizeSentences`**

After `SYS_V1` in `route.ts`:

```ts
export const SYS_V2 = `
Synthesize a concise answer from the provided documents. Write exactly 2-3 clear sentences.

Rules:
- ENGLISH ONLY: Always write every sentence in English, whatever language the
  question or the passages are in. Never mirror the language of the question or
  of a passage — translate what you need instead.
- TRUST SOURCES: The provided sources have been pre-filtered for relevance. Focus on synthesizing their key findings.
- SYNTHESIZE: Combine key information across relevant sources — do NOT copy phrases verbatim
- PRIORITIZE: Focus on the most relevant and important findings
- GROUND: Every claim must be traceable to the provided documents
- CITE: For every sentence, list the ids of the sources it draws on in "cites". Cite only ids that appear in the source list. A sentence with no supporting source must not be written.
- ACCURACY: Preserve the meaning and facts from the original sources
- LIMITATIONS: If sources highlight significant risks, trade-offs, or caveats, include the most important one
- FAITHFULNESS: Only state causal relationships explicitly supported in the sources; use hedging language (e.g., "is associated with", "may contribute to") for correlations or inferences

Return JSON with your answer AND a relevance assessment for every source:
{"sentences":[{"text":"s1","cites":[1,3]},{"text":"s2","cites":[2]}],"source_relevance":[{"id":1,"tier":"strong"},{"id":2,"tier":"weak"}]}

Tier definitions (match these exactly):
- "strong": Information from this source appears in your synthesis. You directly used it.
- "partial": Source is on-topic and could support the answer, but you did not directly use it.
- "weak": Source does not meaningfully address the question.

If no sources adequately answer the question:
{"sentences":[{"text":"The available sources do not contain sufficient information to answer this question.","cites":[]}],"source_relevance":[{"id":1,"tier":"weak"},{"id":2,"tier":"weak"}],"low_coverage":true}
`.trim()

/**
 * Accept either the v2 shape ({text, cites}) or the legacy string shape, and
 * return parallel arrays. Cites are validated against the passages actually
 * sent: an id the model invented is dropped and counted, never rendered.
 */
export function normalizeSentences(
  parsed: any,
  validIds: Set<number>,
): { sentences: string[]; cites: number[][]; invalid: number } {
  const raw: any[] = Array.isArray(parsed?.paragraphs)
    ? parsed.paragraphs.flat()
    : Array.isArray(parsed?.sentences)
      ? parsed.sentences
      : []
  const sentences: string[] = []
  const cites: number[][] = []
  let invalid = 0
  for (const item of raw) {
    if (typeof item === 'string') {
      sentences.push(item)
      cites.push([])
      continue
    }
    if (item && typeof item.text === 'string') {
      sentences.push(item.text)
      const seen = new Set<number>()
      const ok: number[] = []
      for (const c of Array.isArray(item.cites) ? item.cites : []) {
        if (Number.isInteger(c) && validIds.has(c)) {
          if (!seen.has(c)) {
            seen.add(c)
            ok.push(c)
          }
        } else {
          invalid++
        }
      }
      cites.push(ok)
    }
  }
  return { sentences, cites, invalid }
}
```

- [ ] **Step 4: Select the prompt, tell the model about coverage, parse cites**

In `POST`, the `userContent` template: after the `Task:` line append (only when `cfg.likelyOffTopic`):

```ts
    const coverageNote = cfg.likelyOffTopic
      ? `\n\nCoverage check: the question's core topic appears to be absent from this corpus. If the sources do not actually answer it, return the low_coverage response.`
      : ''
    const userContent = `Question: ${query}
… (existing body) …
Task: Evaluate each source's relevance, then write exactly 2-3 clear sentences synthesizing the most important information from the relevant sources. Focus on breadth - touch on multiple key findings rather than elaborating on one.${coverageNote}`
```

Change `{ role: 'system', content: SYS_V1 }` to
`{ role: 'system', content: cfg.promptVersion === 'v1' ? SYS_V1 : SYS_V2 }`.

Replace the "Handle both old format (sentences) and new format (paragraphs)" block (from `let sentences: string[] = []` through the `if (sentences.length === 0)` fallback) with:

```ts
    const validIds = new Set(passagesSent.map((p) => p.id))
    const norm = normalizeSentences(parsed, validIds)
    let sentences = norm.sentences
    let cites = norm.cites
    debugInfo.invalid_cites = norm.invalid

    if (sentences.length === 0) {
      console.log('[Answer Route] No valid sentences parsed, using fallback')
      debugInfo.fallbackReason = 'no_valid_sentences'
      sentences = synthFallback(query, docs).sentences
      cites = sentences.map(() => [])
    }
```

Change `const synthesis: any = { sentences }` to `const synthesis: any = { sentences, cites }`.

Change the low-coverage condition to include the flag:

```ts
    const isLowCoverage =
      cfg.likelyOffTopic ||
      coverageRating === 'poor' ||
      coverageRating === 'limited' ||
      parsed.low_coverage === true
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest src/__tests__/answer-route.test.ts`
Expected: PASS, all describe blocks.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/answer/route.ts src/__tests__/answer-route.test.ts
git commit -m "feat(answer): v2 prompt with per-sentence cites, validated against passages_sent"
```

---

### Task 4: Gateway allowlist; delete the unused answer client

**Files:**
- Modify: `src/app/api/llamaindex/route.ts:46-115`
- Create: `src/__tests__/llamaindex-route-allowlist.test.ts`
- Modify: `src/lib/llamaindex-client.ts` (delete `chatAnswerLlamaIndex`, lines 47-66)
- Modify: `src/__tests__/answer-mode-cite-docs.test.ts:22-34`

**Interfaces:**
- Produces: `export const FORWARDABLE_FIELDS: ReadonlySet<string>` from the gateway route. Unknown body fields → HTTP 400 `{ok:false, error:'Unknown request field(s): …'}`.

- [ ] **Step 1: Write the failing tests**

`src/__tests__/llamaindex-route-allowlist.test.ts`:

```ts
/**
 * @jest-environment node
 *
 * The gateway used to spread the whole request body onto the search-service
 * call, so any stray field could override the mode preset. Now only known
 * QueryRequest fields are forwarded; anything else is a 400.
 */
import { NextRequest } from 'next/server'

const ENV = { ...process.env }
let fetchMock: jest.SpyInstance

function serviceReply() {
  return new Response(
    JSON.stringify({ docs: [], total_results: 0, query: 'q', mode: 'answer', debug: {} }),
    { status: 200 },
  )
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/llamaindex/route')
  const res = await POST(
    new NextRequest('http://localhost/api/llamaindex', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  )
  return { status: res.status, json: await res.json() }
}

function forwarded(): any {
  return JSON.parse(fetchMock.mock.calls[0][1].body)
}

beforeEach(() => {
  jest.resetModules()
  process.env = { ...ENV, SEARCH_SERVICE_URL: 'http://search.test' }
  fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(serviceReply())
})
afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...ENV }
})

describe('POST /api/llamaindex allowlist', () => {
  it('forwards the answer preset with no extra fields', async () => {
    const { status } = await post({ query: 'q', mode: 'answer' })
    expect(status).toBe(200)
    expect(forwarded()).toMatchObject({
      query: 'q',
      mode: 'answer',
      max_results: 15,
      rerank: true,
      similarity_threshold: 0.0,
      include_metadata: true,
    })
  })

  it('forwards eval knobs that are QueryRequest fields', async () => {
    await post({
      query: 'q',
      mode: 'answer',
      expansion_lane_weight: 0.5,
      expansion: false,
      max_results: 30,
      cite_doc_ids: ['a'],
    })
    expect(forwarded()).toMatchObject({
      expansion_lane_weight: 0.5,
      expansion: false,
      max_results: 30,
      cite_doc_ids: ['a'],
    })
  })

  it('keeps forwarding every field the cite results page sends today', async () => {
    await post({
      query: 'q',
      mode: 'cite',
      max_results: 40,
      similarity_threshold: 0.0,
      include_metadata: true,
      rerank: true,
      facets: [{ facet: 'geography', value: 'Brazil' }],
      expansion: true,
    })
    expect(forwarded()).toMatchObject({ max_results: 40, facets: [{ facet: 'geography', value: 'Brazil' }] })
  })

  it('still maps the legacy camelCase overrides', async () => {
    await post({ query: 'q', mode: 'answer', alpha: 0.8, rerankTopK: 5 })
    expect(forwarded()).toMatchObject({ dense_weight: 0.8, sparse_weight: 0.2, rerank_top_n: 5 })
  })

  it('rejects unknown fields with 400 and does not call the service', async () => {
    const { status, json } = await post({ query: 'q', mode: 'answer', rerank_candidates: 5, foo: 1 })
    expect(status).toBe(400)
    expect(json.ok).toBe(false)
    expect(json.error).toContain('rerank_candidates')
    expect(json.error).toContain('foo')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/llamaindex-route-allowlist.test.ts`
Expected: the "rejects unknown fields" test FAILS (status 200 today); others may pass.

- [ ] **Step 3: Implement the allowlist**

In `src/app/api/llamaindex/route.ts`, above `POST`:

```ts
/**
 * Body fields the gateway forwards to the search service's /query. Every name
 * is a QueryRequest field (search-service/app/main.py). The eval harness
 * sweeps retrieval through these; anything not listed is rejected so a stray
 * field can never override a mode preset.
 */
export const FORWARDABLE_FIELDS: ReadonlySet<string> = new Set([
  'max_results',
  'similarity_threshold',
  'include_metadata',
  'rerank',
  'vector_top_k',
  'bm25_top_k',
  'rerank_top_n',
  'fusion_top_k',
  'dense_weight',
  'sparse_weight',
  'expansion_lane_weight',
  'expansion',
  'facets',
  'min_year',
  'max_year',
  'excluded_keywords',
  'required_program',
  'cite_doc_ids',
  'retrieval_mode',
  'return_intermediate_results',
])
```

Replace the destructuring + `...options` usage (lines 48-58 and the spread at line 111) with:

```ts
    const {
      query: rawQuery,
      mode = 'cite',
      alpha,
      denseTopK,
      sparseTopK,
      rerankTopK,
      retrievalMode,
      ...rest
    } = body

    const unknown = Object.keys(rest).filter((k) => !FORWARDABLE_FIELDS.has(k))
    if (unknown.length > 0) {
      return NextResponse.json(
        { ok: false, error: `Unknown request field(s): ${unknown.join(', ')}` },
        { status: 400 },
      )
    }
    const options: Record<string, unknown> = {}
    for (const k of Object.keys(rest)) options[k] = rest[k]
```

The `...options` spread inside `llamaIndexRequest` stays as is (it now only carries allowlisted keys).

- [ ] **Step 4: Delete `chatAnswerLlamaIndex`**

In `src/lib/llamaindex-client.ts` remove the `chatAnswerLlamaIndex` function (lines 47-66). Nothing imports it (verified: only `chatCiteLlamaIndex` is used by `results/page.tsx` and tests).

- [ ] **Step 5: Fix the payload mirror in the old test**

In `src/__tests__/answer-mode-cite-docs.test.ts`, `buildPayload` mirrored the deleted client. Make it mirror `AIResearchModal` (which is what actually runs):

```ts
function buildPayload(
  query: string,
  citeDocIds: string[] | undefined,
): Record<string, unknown> {
  return {
    query,
    mode: 'answer',
    include_metadata: true,
    ...(citeDocIds ? { cite_doc_ids: citeDocIds } : {}),
  }
}
```

and update any assertion in that file that expected `max_results: 100` / `similarity_threshold: 0.05` / `rerank: true` to the new shape (search the file for those literals).

- [ ] **Step 6: Run to verify it passes**

Run: `npx jest src/__tests__/llamaindex-route-allowlist.test.ts src/__tests__/answer-mode-cite-docs.test.ts src/lib/__tests__/llamaindex-client.test.ts src/__tests__/results-page.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/llamaindex/route.ts src/__tests__/llamaindex-route-allowlist.test.ts src/lib/llamaindex-client.ts src/__tests__/answer-mode-cite-docs.test.ts
git commit -m "fix(gateway): allowlist forwardable /query fields; drop unused answer client"
```

---

### Task 5: Citation helpers (pure)

**Files:**
- Create: `src/app/components/AnswerMode/citations.ts`
- Create: `src/app/components/AnswerMode/__tests__/citations.test.ts`
- Modify: `src/app/components/AnswerMode/types.ts`

**Interfaces:**
- Produces (types.ts):
  ```ts
  export interface PassageSent { id: number; doc_id: string; chunk_id: string; page: number; text: string }
  export interface InlineRef { ref: string; page: number; passage_id: string; doc_id: string }
  export interface AnswerResult {
    sentences: string[]
    paragraphs?: string[][]
    inline?: InlineRef[][]
    cites?: number[][]
    warning?: string
    warningMessage?: string
  }
  ```
  and `SupportingCitationsProps` gains `inline?: InlineRef[][]` and loses `directlyCitedCount` and `citationLabels`.
- Produces (citations.ts):
  ```ts
  export function buildInline(cites: number[][], passagesSent: PassageSent[], docs: DocMeta[]): InlineRef[][]
  export function citedDocCount(inline: InlineRef[][] | undefined): number
  export interface CitationItem { doc: DocMeta; kp: KP; label?: string }
  export function orderCitationItems(docs: DocMeta[], inline: InlineRef[][] | undefined): { items: CitationItem[]; citedCount: number; indexByPassageId: Record<string, number> }
  ```
  `passage_id` keys are `${doc_id}:${kp.passage_id}`, the same key `SupportingCitations`/`CitationCard` already use.

- [ ] **Step 1: Update the types**

In `types.ts`, replace the `AnswerResult` interface with the one above, add `PassageSent` and `InlineRef` before it, and in `SupportingCitationsProps` replace

```ts
  directlyCitedCount?: number
  citationLabels?: string[]
```

with

```ts
  inline?: InlineRef[][]
```

- [ ] **Step 2: Write the failing tests**

`src/app/components/AnswerMode/__tests__/citations.test.ts`:

```ts
import { buildInline, citedDocCount, orderCitationItems } from '../citations'
import type { DocMeta } from '@/lib/llamacloud'
import type { PassageSent } from '../types'

function doc(docId: string, passages: Array<[string, number]>): DocMeta {
  return {
    doc_id: docId,
    ref: docId.replace(/[^a-z0-9]+/gi, '_'),
    title: docId,
    kps: passages.map(([pid, rel]) => ({
      kp_relevance: rel,
      snippet: `text of ${pid}`,
      passage_id: pid,
      page: 1,
      citation_targets: [],
    })),
  }
}

const docs: DocMeta[] = [
  doc('A', [['A_chunk_1', 0.9]]),
  doc('B', [['B_chunk_7', 0.8]]),
  doc('C', [['C_chunk_2', 0.7]]),
]
const sent: PassageSent[] = [
  { id: 1, doc_id: 'A', chunk_id: 'A_chunk_1', page: 3, text: 't1' },
  { id: 2, doc_id: 'B', chunk_id: 'B_chunk_7', page: 9, text: 't2' },
  { id: 3, doc_id: 'C', chunk_id: 'C_chunk_2', page: 1, text: 't3' },
]

describe('buildInline', () => {
  it('maps cite ids to the passage sent, with the doc ref and page', () => {
    const inline = buildInline([[2], [1, 3]], sent, docs)
    expect(inline).toEqual([
      [{ ref: 'B', page: 9, passage_id: 'B:B_chunk_7', doc_id: 'B' }],
      [
        { ref: 'A', page: 3, passage_id: 'A:A_chunk_1', doc_id: 'A' },
        { ref: 'C', page: 1, passage_id: 'C:C_chunk_2', doc_id: 'C' },
      ],
    ])
  })

  it('ignores ids with no passage and keeps one entry per sentence', () => {
    expect(buildInline([[9], []], sent, docs)).toEqual([[], []])
  })
})

describe('citedDocCount', () => {
  it('counts distinct documents across all sentences', () => {
    const inline = buildInline([[1, 2], [1, 3]], sent, docs)
    expect(citedDocCount(inline)).toBe(3)
    expect(citedDocCount(buildInline([[1], [1]], sent, docs))).toBe(1)
    expect(citedDocCount(undefined)).toBe(0)
  })
})

describe('orderCitationItems', () => {
  it('lists cited passages first in first-citation order, then the rest by relevance', () => {
    const inline = buildInline([[3], [1, 3]], sent, docs)
    const { items, citedCount, indexByPassageId } = orderCitationItems(docs, inline)
    expect(items.map((i) => i.kp.passage_id)).toEqual(['C_chunk_2', 'A_chunk_1', 'B_chunk_7'])
    expect(citedCount).toBe(2)
    expect(items[0].label).toBe('1.1')
    expect(items[1].label).toBe('2.1')
    expect(items[2].label).toBeUndefined()
    expect(indexByPassageId['C:C_chunk_2']).toBe(0)
    expect(indexByPassageId['A:A_chunk_1']).toBe(1)
    expect(indexByPassageId['B:B_chunk_7']).toBe(2)
  })

  it('with no inline, everything is uncited and sorted by relevance', () => {
    const { items, citedCount } = orderCitationItems(docs, undefined)
    expect(items.map((i) => i.doc.doc_id)).toEqual(['A', 'B', 'C'])
    expect(citedCount).toBe(0)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/app/components/AnswerMode/__tests__/citations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`src/app/components/AnswerMode/citations.ts`:

```ts
import type { DocMeta, KP } from '@/lib/llamacloud'
import type { InlineRef, PassageSent } from './types'

/** The key SupportingCitations and CitationCard already use per passage. */
export function passageKey(docId: string, passageId: string): string {
  return `${docId}:${passageId}`
}

/**
 * Turn the model's per-sentence cite ids into the passages they name. Ids
 * were validated server-side against passages_sent; an id that still fails to
 * resolve here (should not happen) is skipped rather than guessed.
 */
export function buildInline(
  cites: number[][],
  passagesSent: PassageSent[],
  docs: DocMeta[],
): InlineRef[][] {
  const byId = new Map(passagesSent.map((p) => [p.id, p]))
  const refByDoc = new Map(docs.map((d) => [d.doc_id, d.ref]))
  return cites.map((ids) =>
    ids.flatMap((id) => {
      const p = byId.get(id)
      if (!p) return []
      return [
        {
          ref: refByDoc.get(p.doc_id) ?? p.doc_id,
          page: p.page,
          passage_id: passageKey(p.doc_id, p.chunk_id),
          doc_id: p.doc_id,
        },
      ]
    }),
  )
}

export function citedDocCount(inline: InlineRef[][] | undefined): number {
  if (!inline) return 0
  return new Set(inline.flat().map((r) => r.doc_id)).size
}

export interface CitationItem {
  doc: DocMeta
  kp: KP
  /** "s.j" of the first sentence/citation that cites this passage; undefined when uncited. */
  label?: string
}

/**
 * The order the Sources panel renders: every cited passage first, in the
 * order it is first cited, then every other retrieved passage by relevance.
 * indexByPassageId is what a citation marker uses to scroll to its passage.
 */
export function orderCitationItems(
  docs: DocMeta[],
  inline: InlineRef[][] | undefined,
): {
  items: CitationItem[]
  citedCount: number
  indexByPassageId: Record<string, number>
} {
  const all: CitationItem[] = []
  for (const d of docs) {
    for (const kp of d.kps ?? []) all.push({ doc: d, kp })
  }
  const byKey = new Map(all.map((it) => [passageKey(it.doc.doc_id, it.kp.passage_id), it]))

  const cited: CitationItem[] = []
  const citedKeys = new Set<string>()
  ;(inline ?? []).forEach((refs, s) => {
    refs.forEach((r, j) => {
      if (citedKeys.has(r.passage_id)) return
      const it = byKey.get(r.passage_id)
      if (!it) return
      citedKeys.add(r.passage_id)
      cited.push({ ...it, label: `${s + 1}.${j + 1}` })
    })
  })

  const rest = all
    .filter((it) => !citedKeys.has(passageKey(it.doc.doc_id, it.kp.passage_id)))
    .sort((a, b) => b.kp.kp_relevance - a.kp.kp_relevance)

  const items = [...cited, ...rest]
  const indexByPassageId: Record<string, number> = {}
  items.forEach((it, i) => {
    indexByPassageId[passageKey(it.doc.doc_id, it.kp.passage_id)] = i
  })
  return { items, citedCount: cited.length, indexByPassageId }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest src/app/components/AnswerMode/__tests__/citations.test.ts`
Expected: PASS. `npx tsc --noEmit` will now report errors in `AIResearchModal.tsx` / `SupportingCitations.tsx` (removed props) — Task 6 fixes them; do not commit a broken typecheck. Proceed directly to Task 6 before committing, or commit with the types change only if `tsc` is clean.

---

### Task 6: Wire the UI to model-emitted citations

**Files:**
- Modify: `src/app/components/AnswerMode/AIResearchModal.tsx:110-330, 344-410`
- Modify: `src/app/components/AnswerMode/AnswerPanel.tsx:44-46, 195-280`
- Modify: `src/app/components/AnswerMode/SupportingCitations.tsx:19-33, 62-72, 236-330`
- Create: `src/__tests__/answer-panel-citations.test.tsx`

**Interfaces:**
- Consumes: `buildInline`, `citedDocCount`, `orderCitationItems` (Task 5); `synthesis.cites`, `passages_sent`, `likely_off_topic` (Tasks 3, 4).

- [ ] **Step 1: Write the failing test**

`src/__tests__/answer-panel-citations.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { AnswerPanel } from '@/app/components/AnswerMode/AnswerPanel'
import { buildInline } from '@/app/components/AnswerMode/citations'
import type { DocMeta } from '@/lib/llamacloud'

function doc(docId: string, pid: string, rel: number): DocMeta {
  return {
    doc_id: docId,
    ref: docId,
    title: docId,
    kps: [{ kp_relevance: rel, snippet: 'x'.repeat(40), passage_id: pid, page: 1, citation_targets: [] }],
  }
}
const docs = [doc('A', 'A_1', 0.9), doc('B', 'B_1', 0.8), doc('C', 'C_1', 0.7)]
const sent = [
  { id: 1, doc_id: 'A', chunk_id: 'A_1', page: 1, text: 't' },
  { id: 2, doc_id: 'B', chunk_id: 'B_1', page: 1, text: 't' },
  { id: 3, doc_id: 'C', chunk_id: 'C_1', page: 1, text: 't' },
]

function renderPanel(cites: number[][]) {
  const setPage = jest.fn()
  const inline = buildInline(cites, sent, docs)
  render(
    <ChakraProvider>
      <AnswerPanel
        query='q'
        answer={{ sentences: ['One.', 'Two.'], inline, cites }}
        firstDocHowRelevant=''
        supportingDocs={docs}
        setAnswer={jest.fn()}
        setQuery={jest.fn()}
        ops={null}
        setSupportingCitationsPage={setPage}
        supportingCitationsPage={1}
      />
    </ChakraProvider>,
  )
  return { setPage }
}

describe('AnswerPanel citations', () => {
  it('counts only cited documents', () => {
    renderPanel([[3], [3]])
    expect(screen.getByText('Based on 1 Knowledge Product:')).toBeInTheDocument()
  })

  it('a marker scrolls to the passage the model cited, not the k-th passage', () => {
    // Sentence 2 cites C (lowest relevance). Cited-first ordering puts C at
    // index 0, so the marker must request page 1 — under the old
    // slice-by-position logic it would have requested page 2.
    const { setPage } = renderPanel([[], [3]])
    fireEvent.click(screen.getByTitle('Citation 2.1'))
    expect(setPage).toHaveBeenCalledWith(1)
  })

  it('a sentence with no cites renders no markers', () => {
    renderPanel([[], [1]])
    expect(screen.queryByTitle('Citation 1.1')).not.toBeInTheDocument()
    expect(screen.getByTitle('Citation 2.1')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/answer-panel-citations.test.tsx`
Expected: FAIL — count text says "3 Knowledge Products" and/or click requests the wrong page.

- [ ] **Step 3: `AnswerPanel` — count and click**

Add the import: `import { citedDocCount, orderCitationItems } from './citations'`.

Replace lines 44-46:

```ts
  const numberOfUsedKnowledgeProducts = citedDocCount(answer.inline)
  const { indexByPassageId } = orderCitationItems(supportingDocs, answer.inline)
```

In both render branches (paragraphs and sentences), replace the `citationPage` computation and the `globalCitationIdx` counters. For the paragraphs branch, the inner map becomes:

```tsx
                            {answer.inline?.[globalSentIdx]?.map((c, j) => {
                              const citationDisplay = `${globalSentIdx + 1}.${j + 1}`
                              const citationPage =
                                (indexByPassageId[c.passage_id] ?? 0) + 1
                              return (
                                <Button
                                  key={j}
                                  size='small'
                                  variant='secondary'
                                  style={{
                                    fontSize: '9px',
                                    minWidth: 0,
                                    height: 'auto',
                                    lineHeight: 1,
                                    ...(supportingCitationsPage === citationPage
                                      ? { background: '#0A4298', color: 'white' }
                                      : {}),
                                  }}
                                  title={`Citation ${citationDisplay}`}
                                  onClick={() =>
                                    setSupportingCitationsPage?.(citationPage)
                                  }
                                >
                                  {citationDisplay}
                                </Button>
                              )
                            })}
```

and the sentences branch identically with `i` in place of `globalSentIdx`. Delete both `let globalCitationIdx = 0` declarations and the IIFE wrappers they required (the branches become plain `.map` expressions).

- [ ] **Step 4: `SupportingCitations` — order and labels from inline**

Add `inline` to the destructured props and remove `directlyCitedCount = 0` and `citationLabels`. Add the import `import { orderCitationItems } from './citations'`. Replace the `allItems` memo (lines 62-72) with:

```ts
  const { items: allItems, citedCount } = useMemo(
    () => orderCitationItems(supportingDocs, inline),
    [supportingDocs, inline],
  )
```

In the render: replace every `directlyCitedCount` with `citedCount`; in the "Directly cited" map replace `citationLabel={citationLabels?.[idx]}` with `citationLabel={item.label}` (rename the destructured `({ doc, kp }, idx)` to `(item, idx)` and use `item.doc` / `item.kp`). Change the "Additional reading" caption to `Other retrieved excerpts not cited in the answer.`.

- [ ] **Step 5: `AIResearchModal` — send the flag, build inline from cites**

Add the import `import { buildInline } from './citations'`.

After `const { docs, usage, debug } = data` add `const likelyOffTopic = data.likely_off_topic === true`.

Change the `/api/answer` body to:

```ts
        body: JSON.stringify({
          query: query.trim(),
          docs: validDocs,
          likely_off_topic: likelyOffTopic,
        }),
```

Replace the block from `// Collect ALL available chunks/passages from ALL documents` through the end of the `inline` computation (lines 198-248) with:

```ts
        const cites: number[][] = Array.isArray(synthesisResult.synthesis.cites)
          ? synthesisResult.synthesis.cites
          : sentences.map(() => [])
        const passagesSent = Array.isArray(synthesisResult.passages_sent)
          ? synthesisResult.passages_sent
          : []
        const inline = buildInline(cites, passagesSent, validDocs)
```

In `answerWithCitations` add `cites`. In `renderContent`, delete the `citationLabels` computation (lines 344-362) and, on `<SupportingCitations>`, replace

```tsx
              directlyCitedCount={
                answer.inline?.reduce((sum, arr) => sum + arr.length, 0) ?? 0
              }
              citationLabels={citationLabels}
```

with

```tsx
              inline={answer.inline}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx jest src/__tests__/answer-panel-citations.test.tsx src/app/components/AnswerMode src/__tests__/answer-mode-cite-docs.test.ts`
Expected: PASS. Then `npx tsc --noEmit` — expect clean.

- [ ] **Step 7: Commit**

```bash
git add src/app/components/AnswerMode src/__tests__/answer-panel-citations.test.tsx
git commit -m "feat(answer-ui): render model-emitted citations; count cited docs; honor likely_off_topic"
```

---

### Task 7: Full verification and PR

**Files:** none new.

- [ ] **Step 1: Run the whole app-tier suite and the static checks**

```bash
npm test
npm run lint
npm run format:check
npx tsc --noEmit
```

Expected: all green. If `format:check` fails, run `npm run format` and commit the result as `style: prettier`.

- [ ] **Step 2: Manual smoke against the local stack (optional but recommended)**

With the local search service on :8000 and `npm run dev`:

```bash
curl -s -X POST http://localhost:3000/api/llamaindex -H 'content-type: application/json' \
  -d '{"query":"What share of bike-share trips replace car trips in China?","mode":"answer"}' \
  -o /tmp/ret.json -w "HTTP %{http_code}\n"
python3 -c "import json;d=json.load(open('/tmp/ret.json'));json.dump({'query':'What share of bike-share trips replace car trips in China?','docs':d['docs'],'likely_off_topic':d['likely_off_topic']},open('/tmp/ans-req.json','w'))"
curl -s -X POST http://localhost:3000/api/answer -H 'content-type: application/json' -d @/tmp/ans-req.json
```

Expected: `synthesis.cites` present, every id ≤ `passages_sent.length`, `debug.invalid_cites` 0 or small. Open the Answer modal in the browser and confirm markers scroll to the cited passage and "Based on N" equals the distinct cited documents.

- [ ] **Step 3: Open the PR against `qa`**

```bash
git push -u origin worktree-answer-evals-rework
gh pr create --base qa --title "feat(answer): real per-sentence citations, synthesis knobs, provider client, gateway allowlist" --body-file - <<'EOF'
Implements §5.1, §5.2, §5.4 of docs/superpowers/specs/2026-09-03-answer-eval-overhaul-design.md.

- Answer route: v2 prompt where each sentence carries `cites`; ids validated against `passages_sent` (echoed in the response); optional knobs `model`, `base_url`, `max_passages`, `passage_chars`, `prompt_version`, `likely_off_topic` — defaults reproduce the previous 8×400 / 6×350 behaviour.
- Provider-agnostic chat-completions client (`OPENAI_BASE_URL`, `LUNAROUTE_*`); no more hardcoded api.openai.com.
- UI: citation markers point at the passage the model cited; "Based on N Knowledge Products" counts cited documents; Sources panel lists cited passages first; `likely_off_topic` is passed through and renders the low-coverage warning.
- Gateway: allowlist of forwardable `/query` fields; unknown fields → 400. Unused `chatAnswerLlamaIndex` removed.

Behaviour change for users: citations become real. Everything else is unchanged for production callers (tests assert the defaults).
EOF
```

---

## Self-review

**Spec coverage (§5.1, §5.2, §5.4, §6):**
- §5.1 output schema with cites → Task 3. Knobs → Task 2. Shared client / no hardcoded URL → Tasks 1–2 (nano filter included). `passages_sent` + knobs echoed in `debug` → Task 2. `likely_off_topic` warn-and-answer → Task 3.
- §5.2 markers from cites, Directly cited = cited passages, N = cited docs, honor `likely_off_topic` → Task 6.
- §5.4 allowlist, 400 on unknown, `chatAnswerLlamaIndex` deleted → Task 4.
- §6 answer-route tests (cites ∈ passages_sent, invalid dropped/counted, defaults byte-match, base URL reaches client) → Tasks 2–3. Gateway tests → Task 4. UI tests (marker resolves to cited passage, N counts cited docs) → Task 6. `likely_off_topic` renders the warning: covered indirectly (route sets `warning: low_coverage`, `AnswerPanel` already renders `warningMessage` under "Limited coverage" at line ~160); no new UI test added for it.
- Not in this PR by design: §5.3 retrieval flags (sweeps, PR 4), §3/§4 harness and judge (PR 2), eval-review fixture additions (PR 3).

**Placeholder scan:** none.

**Type consistency:** `PassageSent` (Task 2 response, Task 5 type) — same five fields. `InlineRef.passage_id` is `${doc_id}:${chunk_id}` in `buildInline` and `orderCitationItems` keys on `${doc.doc_id}:${kp.passage_id}`; the gateway sets `kps[0].passage_id = metadata.chunk_id || doc_id` and the route sets `chunk_id = kps[0].passage_id`, so the keys agree. `synthesis.cites: number[][]` parallel to `sentences` in Task 3, consumed as such in Task 6.
