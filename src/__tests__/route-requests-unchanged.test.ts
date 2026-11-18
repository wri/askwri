/**
 * @jest-environment node
 *
 * Characterization tests: they freeze the exact bytes every analysis route
 * sends upstream, captured BEFORE the request parameters move into one
 * profile builder. Each fixture asserts the RAW body string of every
 * outbound call, in order (`toBe` on strings — never `toEqual` on a parsed
 * object), so a rewiring that changes a field, a value or even the JSON key
 * order fails here.
 *
 * Arms covered per route, on the code as it stood when these were written:
 *  - each route's default arm (no MODEL_<TASK> lever, no eval override), which
 *    is the model QA was measured running (`handoffs/2026-11-18-qa-baseline-models.md`);
 *  - the GPT-5 arm via the eval override (EVAL_MODEL_OVERRIDE_TOKEN +
 *    x-eval-token + body.model) where the route has one — including
 *    batch-why's o1 arm, which also merges the system prompt;
 *  - the non-GPT-5 arm of the GPT-5-default routes: answer via body.model,
 *    the nano prefilter via MODEL_PREFILTER (+ jest.resetModules(), the lever
 *    is read at import), translate via the eval override.
 *
 * The answer prefilter shuffles passages with Math.random(); those fixtures
 * stub it so the passage order — and therefore the body — is deterministic.
 */
import { NextRequest } from 'next/server'
import { SYS_V1, SYS_V2 } from '@/lib/answer-synthesis'
import { ALIGNMENT_SYSTEM_PROMPT } from '@/config/alignment'

const ENV = { ...process.env }
let fetchMock: jest.SpyInstance

function chatReply(content: string, status = 200) {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content } }],
    }),
    { status },
  )
}

function toolReply(args: object, status = 200) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              {
                function: {
                  name: 'set_assessment',
                  arguments: JSON.stringify(args),
                },
              },
            ],
          },
        },
      ],
    }),
    { status },
  )
}

async function post(
  route: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const { POST } = await import(`@/app/api/${route}/route`)
  const res = await POST(
    new NextRequest(`http://localhost/api/${route}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    }),
  )
  return { status: res.status, json: await res.json() }
}

/** Every outbound call's init.body as the RAW string, in order. */
function rawBodies(): string[] {
  return fetchMock.mock.calls.map(
    ([, init]) => (init as RequestInit).body as string,
  )
}

function expectRawBodies(expected: string[]) {
  const got = rawBodies()
  expect(got).toHaveLength(expected.length)
  got.forEach((body, i) => expect(body).toBe(expected[i]))
}

beforeEach(() => {
  jest.resetModules()
  process.env = { ...ENV, OPENAI_API_KEY: 'sk-test' }
  // A developer's deploy-day .env — loaded by next/jest even under
  // NODE_ENV=test — must not masquerade as a route default, and no test may
  // inherit a sweep token, a token cap or a temperature.
  for (const key of [
    'MODEL_ANSWER',
    'MODEL_PREFILTER',
    'MODEL_WHY',
    'MODEL_RELATES',
    'MODEL_ALIGNMENT',
    'MODEL_TRANSLATE',
    'OPENAI_MAX_TOKENS',
    'OPENAI_TEMPERATURE',
    'USE_NANO_FILTER',
    'EVAL_MODEL_OVERRIDE_TOKEN',
    'ALIGNMENT_TIMEOUT_MS_MAIN',
    'ALIGNMENT_TIMEOUT_MS_REPAIR',
    'OPENAI_BASE_URL',
    'LUNAROUTE_BASE_URL',
    'LUNAROUTE_API_KEY',
  ])
    delete (process.env as Record<string, string | undefined>)[key]
  jest.spyOn(console, 'log').mockImplementation()
  jest.spyOn(console, 'warn').mockImplementation()
  jest.spyOn(console, 'error').mockImplementation()
  fetchMock = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(
      chatReply(JSON.stringify({ sentences: [{ text: 'A.', cites: [1] }] })),
    )
})

afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...ENV }
})

/* ---------------- shared fixture material ---------------- */

const x = (n: number) => 'x'.repeat(n)

/** 1000-char snippets. These fixtures carry 8 documents, which is UNDER the
 *  15-passage default budget — so they lock the sub-budget path, not the
 *  boundary. The boundary gets its own test below, which asserts the passage
 *  count rather than bytes: these bodies were recorded before the refactor and
 *  recapturing them would destroy exactly the evidence they carry. */
function docs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    doc_id: `doc_${i + 1}`,
    title: `Title ${i + 1}`,
    year: 2020,
    kps: [
      {
        kp_relevance: 0.9,
        snippet: x(1000),
        page: 1,
        passage_id: `doc_${i + 1}_chunk_0`,
        citation_targets: [],
      },
    ],
  }))
}

const ANSWER_TASK =
  "Task: Evaluate each source's relevance, then write exactly 2-3 clear sentences synthesizing the most important information from the relevant sources. Focus on breadth - touch on multiple key findings rather than elaborating on one."

function answerUser(count: number, chars: number) {
  const entries = Array.from(
    { length: count },
    (_, i) => `[${i + 1}] "Title ${i + 1}" (2020)\n   Key finding: ${x(chars)}`,
  )
  return `Question: What?\n\nSource documents with key findings:\n${entries.join('\n\n')}\n\n${ANSWER_TASK}`
}

function answerBody(
  model: string,
  sys: string,
  count: number,
  chars: number,
  params: Record<string, number>,
) {
  return JSON.stringify({
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: answerUser(count, chars) },
    ],
    ...params,
  })
}

// Verbatim copy of the nano prefilter's system prompt (answer/route.ts);
// route.ts may not export it (Next's generated type guard rejects non-route
// exports), so the fixture pins it here.
const NANO_SYSTEM_PROMPT = `Given a research question and a set of passages, classify each passage's relevance to the question.

For each passage, classify as:
- "strong": Directly answers or provides specific evidence for the question
- "partial": Related to the topic but does not directly address the question
- "weak": Not meaningfully relevant to the question

Also rate overall corpus coverage for this question:
- "good": Multiple passages directly address the question
- "limited": Some relevant material but significant gaps exist
- "poor": No passages adequately address the question

Return JSON only:
{"relevance":[{"id":1,"tier":"strong"},{"id":2,"tier":"partial"}],"coverage":"good"}`

function nanoUser(count: number, chars: number) {
  const entries = Array.from(
    { length: count },
    (_, i) => `[${i + 1}] "Title ${i + 1}" — ${x(chars)}`,
  )
  return `Question: What?\n\nPassages (presented in random order):\n${entries.join('\n\n')}`
}

function nanoBody(
  model: string,
  params: Record<string, number>,
  count = 8,
  chars = 800,
) {
  return JSON.stringify({
    model,
    messages: [
      { role: 'system', content: NANO_SYSTEM_PROMPT },
      { role: 'user', content: nanoUser(count, chars) },
    ],
    ...params,
  })
}

// Verbatim copy of batch-why's system prompt (batch-why/route.ts).
const WHY_SYSTEM = `You must return a JSON array explaining why each passage is relevant to the query.

Format: [{"why": "explanation", "relation": "direct|indirect"}, ...]

Rules:
- Return ONLY the JSON array, no other text
- ALWAYS write the "why" field in English, even when the passage is in another
  language. Never mirror the passage's language.
- One object per passage in exact order provided
- "why" field: 1-2 sentences explaining relevance
- "relation" field: Use "direct" if the passage explicitly answers or addresses the query's main question. Use "indirect" if it provides background, context, or related information.
- Be specific about what each passage contributes
- Default to "direct" when the passage clearly addresses the query topic`

const WHY_QUERY = 'How do cities cool streets?'

const TWO_PASSAGES = [
  {
    docTitle: 'Urban cooling',
    snippet: 'Tree canopy reduces street temperature.',
  },
  {
    docTitle: 'Rooftop albedo',
    snippet: 'White roofs reflect solar radiation.',
  },
]

const MANY_PASSAGES = Array.from({ length: 40 }, (_, i) => ({
  docTitle: `Doc ${i + 1}`,
  snippet: 'Short snippet.',
}))

function whyUser(passages: { docTitle: string; snippet: string }[]) {
  const list = passages
    .map(
      (p, i) => `**Passage ${i + 1}** (from "${p.docTitle}"):\n${p.snippet}\n`,
    )
    .join('\n')
  return `Query: "${WHY_QUERY}"\n\n${list}\n\nExplain why each passage is relevant to this query:`
}

function whyBody(
  model: string,
  passages: { docTitle: string; snippet: string }[],
  params: Record<string, number>,
  mergeSystem = false,
) {
  const user = whyUser(passages)
  const messages = mergeSystem
    ? [{ role: 'user', content: `${WHY_SYSTEM}\n\n${user}` }]
    : [
        { role: 'system', content: WHY_SYSTEM },
        { role: 'user', content: user },
      ]
  return JSON.stringify({ model, messages, ...params })
}

// Verbatim copy of batch-relates' system prompt (batch-relates/route.ts).
const RELATES_SYSTEM = `You are given a user query and a list of documents. For each document, explain in ONE terse sentence how it relates to the query.

Output a JSON array with one object per document, in the same order:
[{"relates":"...","relation":"direct"|"indirect"}, ...]

Rules:
- ALWAYS write "relates" in English, even when the document or snippet is in
  another language. Never mirror the document's language.
- Do NOT restate the query.
- Avoid generic filler like "by showing evidence/mechanism".
- Be concrete and ≤ 18 words per explanation.
- relation = "direct" if the document explicitly answers the query; otherwise "indirect".
- Return ONLY the JSON array, no other text.`

const TWO_DOCS = [
  {
    title: 'Urban cooling',
    authors: 'A. Author',
    year: '2021',
    snippet: 'Tree canopy reduces street temperature.',
  },
  {
    title: 'Rooftop albedo',
    authors: 'B. Author',
    year: '2022',
    snippet: 'White roofs reflect solar radiation.',
  },
]

const MANY_DOCS = Array.from({ length: 40 }, (_, i) => ({
  title: `Doc ${i + 1}`,
  authors: 'A. Author',
  year: '2021',
  snippet: 'Short snippet.',
}))

function relatesBody(
  model: string,
  docsList: typeof TWO_DOCS,
  params: Record<string, number>,
) {
  const documents = docsList
    .map(
      (d, i) =>
        `Doc ${i + 1}: "${d.title}" (${d.authors}, ${d.year})\nSnippet: ${d.snippet.slice(0, 500)}`,
    )
    .join('\n\n')
  return JSON.stringify({
    model,
    messages: [
      { role: 'system', content: RELATES_SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({
          query: WHY_QUERY,
          document_count: docsList.length,
          documents,
        }),
      },
    ],
    ...params,
  })
}

const SUMMARY =
  'Results for: How do cities cool streets?\n1. Urban cooling — tree canopy reduces street temperature.'

// Verbatim copy of the alignment route's response schema and tool definition.
const ALIGNMENT_SCHEMA = {
  name: 'alignment_assessment',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['insights', 'alignment'],
    properties: {
      insights: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 5,
      },
      alignment: {
        type: 'string',
        enum: ['High', 'Moderate', 'Low', 'Very Low'],
      },
    },
  },
}

const TOOL_DEF = [
  {
    type: 'function',
    function: {
      name: 'set_assessment',
      description: 'Return the alignment assessment JSON.',
      parameters: ALIGNMENT_SCHEMA.schema,
    },
  },
]

function alignmentMessages() {
  return [
    { role: 'system', content: ALIGNMENT_SYSTEM_PROMPT },
    { role: 'user', content: SUMMARY },
  ]
}

function schemaAttempt(model: string, params: Record<string, number>) {
  return JSON.stringify({
    model,
    messages: alignmentMessages(),
    response_format: { type: 'json_schema', json_schema: ALIGNMENT_SCHEMA },
    ...params,
  })
}

function toolsAttempt(model: string, params: Record<string, number>) {
  return JSON.stringify({
    model,
    messages: alignmentMessages(),
    tools: TOOL_DEF,
    tool_choice: { type: 'function', function: { name: 'set_assessment' } },
    ...params,
  })
}

function objectAttempt(model: string, params: Record<string, number>) {
  return JSON.stringify({
    model,
    messages: alignmentMessages(),
    response_format: { type: 'json_object' },
    ...params,
  })
}

const GOOD_ASSESSMENT = JSON.stringify({
  insights: [
    'Tree canopy studies directly measure how shade cools streets.',
    'Rooftop albedo evidence is thinner but still directly relevant.',
  ],
  alignment: 'High',
})

// Verbatim copy of the translate route's system prompt (translate/route.ts).
const TRANSLATE_SYSTEM = `You translate excerpts from research publications into English.

Rules:
- Return ONLY the English translation, with no preamble, notes or quotation marks.
- Preserve the meaning, register and paragraph breaks of the source.
- Keep numbers, units, dates and proper nouns intact.
- The excerpt may include markers like **[ ... ]** around the retrieved passage;
  keep those markers exactly where they are.
- If the text is already in English, return it unchanged.`

function translateBody(model: string, params: Record<string, number>) {
  return JSON.stringify({
    model,
    messages: [
      { role: 'system', content: TRANSLATE_SYSTEM },
      { role: 'user', content: 'Hola mundo' },
    ],
    ...params,
  })
}

/* ---------------- POST /api/answer ---------------- */

describe('POST /api/answer — raw request bytes', () => {
  it('default arm (prefilter off): one gpt-5.4-mini call, 15×800 evidence budget', async () => {
    await post('answer', { query: 'What?', docs: docs(8) })
    expectRawBodies([
      answerBody('gpt-5.4-mini', SYS_V2, 8, 800, {
        max_completion_tokens: 2000,
      }),
    ])
  })

  it('16 documents are capped at the 15-passage default budget', async () => {
    // The boundary the byte fixtures cannot reach: 8 documents sit under the
    // 15-passage default, so only a count assertion catches a 15 -> 8 change.
    await post('answer', { query: 'What?', docs: docs(16) })
    const body = JSON.parse(rawBodies()[0])
    const passages = (body.messages[1].content.match(/^\[\d+\]/gm) ?? []).length
    expect(passages).toBe(15)
  })

  it('prompt_version v1 swaps the system prompt, bytes otherwise identical', async () => {
    await post('answer', {
      query: 'What?',
      docs: docs(8),
      prompt_version: 'v1',
    })
    expectRawBodies([
      answerBody('gpt-5.4-mini', SYS_V1, 8, 800, {
        max_completion_tokens: 2000,
      }),
    ])
  })

  it('an explicit max_passages override shrinks the evidence list', async () => {
    await post('answer', { query: 'What?', docs: docs(8), max_passages: 3 })
    expectRawBodies([
      answerBody('gpt-5.4-mini', SYS_V2, 3, 800, {
        max_completion_tokens: 2000,
      }),
    ])
  })

  it('the non-GPT-5 arm via body.model: 6×350 evidence, max_tokens + temperature', async () => {
    await post('answer', {
      query: 'What?',
      docs: docs(8),
      model: 'gpt-4o-mini',
    })
    expectRawBodies([
      answerBody('gpt-4o-mini', SYS_V2, 6, 350, {
        max_tokens: 1500,
        temperature: 0.3,
      }),
    ])
  })

  it('prefilter enabled and succeeding: nano call first, then synthesis', async () => {
    process.env.USE_NANO_FILTER = 'true'
    // The nano filter shuffles passages with Math.random(); stub it so the
    // order — and therefore the body — is byte-stable.
    jest.spyOn(Math, 'random').mockReturnValue(0.999999999)
    fetchMock.mockImplementation(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      return body.model === 'gpt-5.4-nano'
        ? chatReply(
            JSON.stringify({
              relevance: Array.from({ length: 8 }, (_, i) => ({
                id: i + 1,
                tier: 'strong',
              })),
              coverage: 'good',
            }),
          )
        : chatReply(JSON.stringify({ sentences: [{ text: 'A.', cites: [1] }] }))
    })
    await post('answer', { query: 'What?', docs: docs(8) })
    expectRawBodies([
      nanoBody('gpt-5.4-nano', { max_completion_tokens: 500 }),
      answerBody('gpt-5.4-mini', SYS_V2, 8, 800, {
        max_completion_tokens: 2000,
      }),
    ])
  })

  it('prefilter enabled and the provider failing: same two bodies, all docs kept', async () => {
    process.env.USE_NANO_FILTER = 'true'
    jest.spyOn(Math, 'random').mockReturnValue(0.999999999)
    fetchMock.mockImplementation(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      return body.model === 'gpt-5.4-nano'
        ? chatReply('upstream error', 500)
        : chatReply(JSON.stringify({ sentences: [{ text: 'A.', cites: [1] }] }))
    })
    await post('answer', { query: 'What?', docs: docs(8) })
    expectRawBodies([
      nanoBody('gpt-5.4-nano', { max_completion_tokens: 500 }),
      answerBody('gpt-5.4-mini', SYS_V2, 8, 800, {
        max_completion_tokens: 2000,
      }),
    ])
  })

  it('prefilter non-GPT-5 arm via MODEL_PREFILTER: max_tokens 500 + temperature 0.1', async () => {
    process.env.USE_NANO_FILTER = 'true'
    process.env.MODEL_PREFILTER = 'gpt-4o-mini'
    jest.spyOn(Math, 'random').mockReturnValue(0.999999999)
    fetchMock.mockImplementation(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      return body.model === 'gpt-4o-mini'
        ? chatReply(
            JSON.stringify({
              relevance: Array.from({ length: 8 }, (_, i) => ({
                id: i + 1,
                tier: 'strong',
              })),
              coverage: 'good',
            }),
          )
        : chatReply(JSON.stringify({ sentences: [{ text: 'A.', cites: [1] }] }))
    })
    await post('answer', { query: 'What?', docs: docs(8) })
    expectRawBodies([
      nanoBody('gpt-4o-mini', { max_tokens: 500, temperature: 0.1 }),
      answerBody('gpt-5.4-mini', SYS_V2, 8, 800, {
        max_completion_tokens: 2000,
      }),
    ])
  })
})

/* ---------------- POST /api/batch-why ---------------- */

describe('POST /api/batch-why — raw request bytes', () => {
  it('default arm (gpt-5.4-nano, the deployed model): max_completion_tokens 360, no temperature', async () => {
    await post('batch-why', { query: WHY_QUERY, passages: TWO_PASSAGES })
    expectRawBodies([
      whyBody('gpt-5.4-nano', TWO_PASSAGES, { max_completion_tokens: 360 }),
    ])
  })

  it('default arm above the 35-passage cap: budget clamped to 3000', async () => {
    await post('batch-why', { query: WHY_QUERY, passages: MANY_PASSAGES })
    expectRawBodies([
      whyBody('gpt-5.4-nano', MANY_PASSAGES, { max_completion_tokens: 3000 }),
    ])
  })

  it('GPT-5 arm via the eval override: no temperature, uncapped below 3000', async () => {
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    await post(
      'batch-why',
      { query: WHY_QUERY, passages: TWO_PASSAGES, model: 'gpt-5-mini' },
      { 'x-eval-token': 'secret' },
    )
    expectRawBodies([
      whyBody('gpt-5-mini', TWO_PASSAGES, { max_completion_tokens: 360 }),
    ])
  })

  it('GPT-5 arm above the cap: budget clamped to 3000', async () => {
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    await post(
      'batch-why',
      { query: WHY_QUERY, passages: MANY_PASSAGES, model: 'gpt-5-mini' },
      { 'x-eval-token': 'secret' },
    )
    expectRawBodies([
      whyBody('gpt-5-mini', MANY_PASSAGES, { max_completion_tokens: 3000 }),
    ])
  })

  it('the o1 arm via the eval override: system merged into the user message, no temperature', async () => {
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    await post(
      'batch-why',
      { query: WHY_QUERY, passages: TWO_PASSAGES, model: 'o1-mini' },
      { 'x-eval-token': 'secret' },
    )
    expectRawBodies([
      whyBody('o1-mini', TWO_PASSAGES, { max_completion_tokens: 360 }, true),
    ])
  })

  it('an unregistered non-o1/non-gpt-4o id via the eval override: today\u2019s final else arm (max_tokens + 0.3)', async () => {
    // Captured on the pre-change tree (27543fe): the fallback arm inside
    // requestProfile must keep reproducing these bytes for ids the registry
    // does not know.
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    await post(
      'batch-why',
      { query: WHY_QUERY, passages: TWO_PASSAGES, model: 'glm-5.2-vision' },
      { 'x-eval-token': 'secret' },
    )
    expectRawBodies([
      whyBody('glm-5.2-vision', TWO_PASSAGES, {
        max_tokens: 360,
        temperature: 0.3,
      }),
    ])
  })

  it('a registered gpt-6 candidate via the eval override: max_completion_tokens at the task effort, no temperature', async () => {
    // This body is NOT a behaviour promise, and it was wrong to pin it as one. No
    // task is assigned a candidate, so the only thing that sends this arm is the
    // route sweep's override. The pre-change capture (27543fe) had `max_tokens`
    // because gpt-6-luna was then an unregistered id falling through to the
    // legacy arm — and the singleton that kept those bytes identical was a
    // registry entry claiming the GPT-6 class rejects max_completion_tokens, which
    // is false: `npm run probe:models` sends max_completion_tokens at the task's
    // effort and every GPT-6 case came back accepted and usable. A reasoning
    // family is the one place max_tokens is most likely to be refused.
    //
    // The reasoning arm landed since: the task's effort now rides along, so the
    // family's temperature rejection applies and the field is gone.
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    await post(
      'batch-why',
      { query: WHY_QUERY, passages: TWO_PASSAGES, model: 'gpt-6-luna' },
      { 'x-eval-token': 'secret' },
    )
    expectRawBodies([
      whyBody('gpt-6-luna', TWO_PASSAGES, { max_completion_tokens: 360 }),
    ])
  })
})

/* ---------------- POST /api/batch-relates ---------------- */

describe('POST /api/batch-relates — raw request bytes', () => {
  it('default arm (gpt-5.4-nano, the deployed model): floor 1000, no temperature', async () => {
    await post('batch-relates', { query: WHY_QUERY, docs: TWO_DOCS })
    expectRawBodies([
      relatesBody('gpt-5.4-nano', TWO_DOCS, { max_completion_tokens: 1000 }),
    ])
  })

  it('default arm above the floor: 120×docs unclamped', async () => {
    await post('batch-relates', { query: WHY_QUERY, docs: MANY_DOCS })
    expectRawBodies([
      relatesBody('gpt-5.4-nano', MANY_DOCS, { max_completion_tokens: 4800 }),
    ])
  })

  it('GPT-5 arm via the eval override: floor 1000, no temperature', async () => {
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    await post(
      'batch-relates',
      { query: WHY_QUERY, docs: TWO_DOCS, model: 'gpt-5-mini' },
      { 'x-eval-token': 'secret' },
    )
    expectRawBodies([
      relatesBody('gpt-5-mini', TWO_DOCS, { max_completion_tokens: 1000 }),
    ])
  })

  it('GPT-5 arm above the floor: 120×docs unclamped', async () => {
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    await post(
      'batch-relates',
      { query: WHY_QUERY, docs: MANY_DOCS, model: 'gpt-5-mini' },
      { 'x-eval-token': 'secret' },
    )
    expectRawBodies([
      relatesBody('gpt-5-mini', MANY_DOCS, { max_completion_tokens: 4800 }),
    ])
  })
})

/* ---------------- POST /api/alignment ---------------- */

describe('POST /api/alignment — raw request bytes', () => {
  it('default arm (gpt-5.4-nano, the deployed model): cap 4000, json_schema first', async () => {
    fetchMock.mockResolvedValue(chatReply(GOOD_ASSESSMENT))
    await post('alignment', { query: WHY_QUERY, resultsSummary: SUMMARY })
    expectRawBodies([
      schemaAttempt('gpt-5.4-nano', { max_completion_tokens: 4000 }),
    ])
  })

  it('schema fails then tools succeeds: both primary budgets, same arm', async () => {
    fetchMock
      .mockResolvedValueOnce(chatReply('nope', 500))
      .mockResolvedValueOnce(
        toolReply({
          insights: [
            'Tree canopy studies directly measure how shade cools streets.',
            'Rooftop albedo evidence is thinner but still directly relevant.',
          ],
          alignment: 'High',
        }),
      )
    await post('alignment', { query: WHY_QUERY, resultsSummary: SUMMARY })
    expectRawBodies([
      schemaAttempt('gpt-5.4-nano', { max_completion_tokens: 4000 }),
      toolsAttempt('gpt-5.4-nano', { max_completion_tokens: 4000 }),
    ])
  })

  it('schema and tools fail then json_object: the repair cap is 5000', async () => {
    fetchMock
      .mockResolvedValueOnce(chatReply('nope', 500))
      .mockResolvedValueOnce(chatReply('nope again', 500))
      .mockResolvedValueOnce(chatReply(GOOD_ASSESSMENT))
    await post('alignment', { query: WHY_QUERY, resultsSummary: SUMMARY })
    expectRawBodies([
      schemaAttempt('gpt-5.4-nano', { max_completion_tokens: 4000 }),
      toolsAttempt('gpt-5.4-nano', { max_completion_tokens: 4000 }),
      objectAttempt('gpt-5.4-nano', { max_completion_tokens: 5000 }),
    ])
  })

  it('GPT-5 arm via the eval override: cap 4000, no temperature, json_schema first', async () => {
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    fetchMock.mockResolvedValue(chatReply(GOOD_ASSESSMENT))
    await post(
      'alignment',
      { query: WHY_QUERY, resultsSummary: SUMMARY, model: 'gpt-5-mini' },
      { 'x-eval-token': 'secret' },
    )
    expectRawBodies([
      schemaAttempt('gpt-5-mini', { max_completion_tokens: 4000 }),
    ])
  })

  it('GPT-5 arm through the whole ladder: repair cap 5000, no temperature', async () => {
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    fetchMock
      .mockResolvedValueOnce(chatReply('nope', 500))
      .mockResolvedValueOnce(chatReply('nope again', 500))
      .mockResolvedValueOnce(chatReply(GOOD_ASSESSMENT))
    await post(
      'alignment',
      { query: WHY_QUERY, resultsSummary: SUMMARY, model: 'gpt-5-mini' },
      { 'x-eval-token': 'secret' },
    )
    expectRawBodies([
      schemaAttempt('gpt-5-mini', { max_completion_tokens: 4000 }),
      toolsAttempt('gpt-5-mini', { max_completion_tokens: 4000 }),
      objectAttempt('gpt-5-mini', { max_completion_tokens: 5000 }),
    ])
  })
})

/* ---------------- POST /api/translate ---------------- */

describe('POST /api/translate — raw request bytes', () => {
  it('default arm (gpt-5.4-mini, the deployed model): max_completion_tokens 2000', async () => {
    fetchMock.mockResolvedValue(chatReply('Hello world'))
    await post('translate', { text: 'Hola mundo' })
    expectRawBodies([
      translateBody('gpt-5.4-mini', { max_completion_tokens: 2000 }),
    ])
  })

  it('the non-GPT-5 arm via the eval override: max_tokens 1200 + temperature 0.2', async () => {
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    fetchMock.mockResolvedValue(chatReply('Hello world'))
    await post(
      'translate',
      { text: 'Hola mundo', model: 'gpt-4o-mini' },
      { 'x-eval-token': 'secret' },
    )
    expectRawBodies([
      translateBody('gpt-4o-mini', { max_tokens: 1200, temperature: 0.2 }),
    ])
  })

  it('an upstream 400 sends the same single body and answers 502', async () => {
    fetchMock.mockResolvedValue(chatReply('bad request', 400))
    const { status } = await post('translate', { text: 'Hola mundo' })
    expect(status).toBe(502)
    expectRawBodies([
      translateBody('gpt-5.4-mini', { max_completion_tokens: 2000 }),
    ])
  })

  it('an empty completion sends the same single body and answers 502', async () => {
    fetchMock.mockResolvedValue(chatReply('   '))
    const { status } = await post('translate', { text: 'Hola mundo' })
    expect(status).toBe(502)
    expectRawBodies([
      translateBody('gpt-5.4-mini', { max_completion_tokens: 2000 }),
    ])
  })
})
