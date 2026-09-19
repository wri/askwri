import { resolveProvider } from '@/lib/llm/chat-completions'

const DEFAULT_MODEL = (process.env.OPENAI_MODEL ?? 'gpt-5.4').trim()
export const MAX_PASSAGES_CAP = 15

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
 * request knobs. With no knobs this reproduces the 2026-09-10 default change
 * (gpt-5*: 15 passages × 800 chars; else 6 × 350) — measured in the
 * 15×800 confirmation run (see evaluation/baselines/2026-09-10-answer-
 * noselection-knobconfirm15x800-3pass-compare.md; §10.4 no-selection
 * confirmation preceded this default). The knobs exist for the eval
 * harness's sweeps; production callers never send them.
 */
export function resolveSynthesisConfig(body: any): SynthesisConfig {
  const str = (v: unknown) =>
    typeof v === 'string' && v.trim() !== '' ? v : undefined
  const provider = resolveProvider(DEFAULT_MODEL, {
    model: str(body?.model),
    base_url: str(body?.base_url),
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
    maxPassages: int(
      body?.max_passages,
      provider.isGpt5 ? 15 : 6, // gpt-5 default equals MAX_PASSAGES_CAP — raising the default requires raising the cap
      MAX_PASSAGES_CAP,
    ),
    passageChars: int(body?.passage_chars, provider.isGpt5 ? 800 : 350, 20_000),
    promptVersion: body?.prompt_version === 'v1' ? 'v1' : 'v2',
    likelyOffTopic: body?.likely_off_topic === true,
  }
}

// Concise prompt for 2-3 sentence answers
export const SYS_V1 = `
Synthesize a concise answer from the provided documents. Write exactly 2-3 clear sentences.

Rules:
- ENGLISH ONLY: Always write every sentence in English, whatever language the
  question or the passages are in. Never mirror the language of the question or
  of a passage — translate what you need instead.
- TRUST SOURCES: The provided sources have been pre-filtered for relevance. Focus on synthesizing their key findings.
- SYNTHESIZE: Combine key information across relevant sources — do NOT copy phrases verbatim
- PRIORITIZE: Focus on the most relevant and important findings
- GROUND: Every claim must be traceable to the provided documents
- ACCURACY: Preserve the meaning and facts from the original sources
- LIMITATIONS: If sources highlight significant risks, trade-offs, or caveats, include the most important one
- FAITHFULNESS: Only state causal relationships explicitly supported in the sources; use hedging language (e.g., "is associated with", "may contribute to") for correlations or inferences

Return JSON with your answer AND a relevance assessment for every source:
{"sentences":["s1","s2","s3"],"source_relevance":[{"id":1,"tier":"strong"},{"id":2,"tier":"weak"}]}

Tier definitions (match these exactly):
- "strong": Information from this source appears in your synthesis. You directly used it.
- "partial": Source is on-topic and could support the answer, but you did not directly use it.
- "weak": Source does not meaningfully address the question.

If no sources adequately answer the question:
{"sentences":["The available sources do not contain sufficient information to answer this question."],"source_relevance":[{"id":1,"tier":"weak"},{"id":2,"tier":"weak"}],"low_coverage":true}
`.trim()

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
