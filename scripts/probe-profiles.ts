/**
 * One representative fixture per real call site, built the way that call site
 * builds it — same messages, same prompt text, same omission rules — so the
 * probe measures the requests we actually make.
 *
 * Prompt text a route keeps private is copied here: a `route.ts` may export only
 * routes (Next's generated type guard fails the production build otherwise), so
 * the prefilter, why, relates, translate and alignment schema/tools bodies are
 * copies. The two that already live in `src/lib` are imported so they cannot
 * drift.
 *
 * Bump PROFILES_VERSION whenever a fixture changes shape; the CLI prints it.
 */
import { ALIGNMENT_SYSTEM_PROMPT } from '@/config/alignment'
import { SYS_V2 } from '@/lib/answer-synthesis'

import type { Effort, ProbeProfile, ProfileId } from './probe-models'

export const PROFILES_VERSION = 'v1'

const QUERY =
  'How does urban tree cover affect surface temperature in tropical cities?'

/** Long enough that the routes' per-passage caps actually truncate. */
const long = (seed: string, chars: number) =>
  seed.repeat(Math.ceil(chars / seed.length)).slice(0, chars)

const DOCS = Array.from({ length: 6 }, (_, i) => ({
  title: `City heat and canopy study ${i + 1}`,
  authors: `Author ${i + 1}`,
  year: String(2016 + i),
  doc_id: `wri-doc-${i + 1}`,
  chunk_id: `chunk-${100 + i}`,
  page: i + 1,
  snippet: long(
    `Canopy cover of ${25 + i * 4}% was associated with a ${(0.8 + i / 3).toFixed(1)}°C lower midday surface temperature in the study city. `,
    900,
  ),
}))

const PASSAGES = Array.from({ length: 25 }, (_, i) => ({
  docTitle: DOCS[i % DOCS.length].title,
  snippet: long(
    `Passage ${i + 1}: mature street trees shade pavements and cut afternoon surface heat. `,
    300,
  ),
}))

const RESULTS_SUMMARY = [
  `Query: ${QUERY}`,
  `Sources found: ${DOCS.length}`,
  '',
  ...DOCS.map(
    (d, i) =>
      `[${i + 1}] "${d.title}" (${d.year}) — ${d.snippet.slice(0, 200)}`,
  ),
  '',
  'Languages among the results: Spanish, English',
].join('\n')

/** What a GPT-6 request looks like: the task's effort, a completion-token cap,
 *  and no temperature — the family rejects it when effort is not `none`. */
const reasoningBody = (args: {
  model: string
  effort: Effort
  budget: number
  messages: Array<{ role: string; content: string }>
  extra?: Record<string, unknown>
}) => ({
  model: args.model,
  messages: args.messages,
  reasoning_effort: args.effort,
  max_completion_tokens: args.budget,
  ...args.extra,
})

/* ---------------- POST /api/answer ---------------- */
// 6 documents at the GPT-5-class passage budget (15 × 800 chars), no
// response_format: the route asks for JSON in the prompt.
const ANSWER_DOCS = DOCS.map((d, i) => ({
  id: i + 1,
  title: d.title,
  year: d.year,
  doc_id: d.doc_id,
  chunk_id: d.chunk_id,
  page: d.page,
  key_finding: d.snippet.slice(0, 800),
}))

const ANSWER_MESSAGES = [
  { role: 'system', content: SYS_V2 },
  {
    role: 'user',
    content: `Question: ${QUERY}

Source documents with key findings:
${ANSWER_DOCS.map(
  (d) =>
    `[${d.id}] "${d.title}" (${d.year || 'n.d.'})
   Key finding: ${d.key_finding}`,
).join('\n\n')}

Task: Evaluate each source's relevance, then write exactly 2-3 clear sentences synthesizing the most important information from the relevant sources. Focus on breadth - touch on multiple key findings rather than elaborating on one.`,
  },
]

/* ---------------- answer pre-filter (nano) ---------------- */
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

// The route shuffles to defeat position bias; the probe keeps a fixed order so
// two runs are comparable.
const PREFILTER_MESSAGES = [
  { role: 'system', content: NANO_SYSTEM_PROMPT },
  {
    role: 'user',
    content: `Question: ${QUERY}

Passages (presented in random order):
${ANSWER_DOCS.map((d) => `[${d.id}] "${d.title}" — ${d.key_finding}`).join('\n\n')}`,
  },
]

/* ---------------- POST /api/batch-why ---------------- */
const WHY_SYSTEM_PROMPT = `You must return a JSON array explaining why each passage is relevant to the query.

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

const whyPassageList = () => {
  const totalLength = PASSAGES.reduce((sum, p) => sum + p.snippet.length, 0)
  const maxPerSnippet = totalLength > 2000 ? 200 : 300
  return PASSAGES.map((p, i) => {
    const snippet = p.snippet
    const truncated =
      snippet.length > maxPerSnippet
        ? `${snippet.slice(0, maxPerSnippet)}...`
        : snippet
    return `**Passage ${i + 1}** (from "${p.docTitle}"):\n${truncated}\n`
  }).join('\n')
}

const WHY_MESSAGES = [
  { role: 'system', content: WHY_SYSTEM_PROMPT },
  {
    role: 'user',
    content: `Query: "${QUERY}"\n\n${whyPassageList()}\n\nExplain why each passage is relevant to this query:`,
  },
]

/* ---------------- POST /api/batch-relates ---------------- */
const RELATES_SYSTEM_PROMPT = `
You are given a user query and a list of documents. For each document, explain in ONE terse sentence how it relates to the query.

Output a JSON array with one object per document, in the same order:
[{"relates":"...","relation":"direct"|"indirect"}, ...]

Rules:
- ALWAYS write "relates" in English, even when the document or snippet is in
  another language. Never mirror the document's language.
- Do NOT restate the query.
- Avoid generic filler like "by showing evidence/mechanism".
- Be concrete and ≤ 18 words per explanation.
- relation = "direct" if the document explicitly answers the query; otherwise "indirect".
- Return ONLY the JSON array, no other text.
`.trim()

const RELATES_MESSAGES = [
  { role: 'system', content: RELATES_SYSTEM_PROMPT },
  {
    role: 'user',
    content: JSON.stringify({
      query: QUERY,
      document_count: DOCS.length,
      documents: DOCS.map(
        (doc, i) =>
          `Doc ${i + 1}: "${doc.title}" (${doc.authors}, ${doc.year})\nSnippet: ${doc.snippet.slice(0, 500)}`,
      ).join('\n\n'),
    }),
  },
]

/* ---------------- POST /api/translate ---------------- */
const TRANSLATE_SYS = `
You translate excerpts from research publications into English.

Rules:
- Return ONLY the English translation, with no preamble, notes or quotation marks.
- Preserve the meaning, register and paragraph breaks of the source.
- Keep numbers, units, dates and proper nouns intact.
- The excerpt may include markers like **[ ... ]** around the retrieved passage;
  keep those markers exactly where they are.
- If the text is already in English, return it unchanged.
`.trim()

const TRANSLATE_SOURCE = long(
  'La cobertura arbórea urbana reduce la temperatura superficial del mediodía y mejora el confort térmico en ciudades tropicales. ',
  900,
)

/* ---------------- GET|POST /api/alignment ---------------- */
// Copied from the route: its three attempts are three different bodies.
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

const ALIGNMENT_TOOL_DEF = [
  {
    type: 'function',
    function: {
      name: 'set_assessment',
      description: 'Return the alignment assessment JSON.',
      parameters: ALIGNMENT_SCHEMA.schema,
    },
  },
]

const ALIGNMENT_MESSAGES = [
  { role: 'system', content: ALIGNMENT_SYSTEM_PROMPT },
  { role: 'user', content: RESULTS_SUMMARY },
]

export const profiles: Record<ProfileId, ProbeProfile> = {
  answer: {
    id: 'answer',
    inputCount: ANSWER_DOCS.length,
    expect: 'json_object',
    requiredFields: ['sentences', 'source_relevance'],
    body: ({ model, effort, budget }) =>
      reasoningBody({ model, effort, budget, messages: ANSWER_MESSAGES }),
  },
  prefilter: {
    id: 'prefilter',
    inputCount: ANSWER_DOCS.length,
    expect: 'json_object',
    requiredFields: ['relevance'],
    body: ({ model, effort, budget }) =>
      reasoningBody({ model, effort, budget, messages: PREFILTER_MESSAGES }),
  },
  why: {
    id: 'why',
    inputCount: PASSAGES.length,
    expect: 'json_object',
    minItems: PASSAGES.length,
    body: ({ model, effort, budget }) =>
      reasoningBody({ model, effort, budget, messages: WHY_MESSAGES }),
  },
  relates: {
    id: 'relates',
    inputCount: DOCS.length,
    expect: 'json_object',
    minItems: DOCS.length,
    body: ({ model, effort, budget }) =>
      reasoningBody({ model, effort, budget, messages: RELATES_MESSAGES }),
  },
  'alignment.schema': {
    id: 'alignment.schema',
    inputCount: DOCS.length,
    expect: 'json_object',
    requiredFields: ['insights', 'alignment'],
    body: ({ model, effort, budget }) =>
      reasoningBody({
        model,
        effort,
        budget,
        messages: ALIGNMENT_MESSAGES,
        extra: {
          response_format: {
            type: 'json_schema',
            json_schema: ALIGNMENT_SCHEMA,
          },
        },
      }),
  },
  'alignment.tools': {
    id: 'alignment.tools',
    inputCount: DOCS.length,
    expect: 'json_object',
    requiredFields: ['insights', 'alignment'],
    body: ({ model, effort, budget }) =>
      reasoningBody({
        model,
        effort,
        budget,
        messages: ALIGNMENT_MESSAGES,
        extra: {
          tools: ALIGNMENT_TOOL_DEF,
          tool_choice: {
            type: 'function',
            function: { name: 'set_assessment' },
          },
        },
      }),
  },
  'alignment.json_object': {
    id: 'alignment.json_object',
    inputCount: DOCS.length,
    expect: 'json_object',
    requiredFields: ['insights', 'alignment'],
    body: ({ model, effort, budget }) =>
      reasoningBody({
        model,
        effort,
        budget,
        messages: ALIGNMENT_MESSAGES,
        extra: { response_format: { type: 'json_object' } },
      }),
  },
  translate: {
    id: 'translate',
    inputCount: 1,
    expect: 'text',
    body: ({ model, effort, budget }) =>
      reasoningBody({
        model,
        effort,
        budget,
        messages: [
          { role: 'system', content: TRANSLATE_SYS },
          { role: 'user', content: TRANSLATE_SOURCE.slice(0, 4000) },
        ],
      }),
  },
}
