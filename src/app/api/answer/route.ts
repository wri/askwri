// Route: POST /api/answer
// Crisp 3–5 sentence synthesis, model-aware (gpt-5*: max_completion_tokens & omit temperature).
import { NextRequest, NextResponse } from 'next/server'

import { chatCompletion, resolveProvider } from '@/lib/llm/chat-completions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

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
      provider.isGpt5 ? 8 : 6,
      MAX_PASSAGES_CAP,
    ),
    passageChars: int(body?.passage_chars, provider.isGpt5 ? 400 : 350, 20_000),
    promptVersion: body?.prompt_version === 'v1' ? 'v1' : 'v2',
    likelyOffTopic: body?.likely_off_topic === true,
  }
}

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

function synthFallback(query: string, docs: any[]) {
  // Only used when API key is missing or there's a critical error
  // This should rarely be seen by users
  if (!docs?.length) {
    return { sentences: ['No relevant documents found to answer this query.'] }
  }

  return {
    sentences: [
      'Answer synthesis is temporarily unavailable.',
      'Please review the source documents below for information on this topic.',
    ],
  }
}

function safeParse(text: string, allowPartial: boolean = false) {
  try {
    return JSON.parse(text)
  } catch (err1) {
    console.log('[safeParse] First parse failed:', (err1 as Error).message)
    console.log('[safeParse] Content sample:', text.slice(0, 200))

    // Try extracting JSON from text
    const s = text.indexOf('{'),
      e = text.lastIndexOf('}')
    if (s !== -1 && e !== -1 && e > s) {
      const extracted = text.slice(s, e + 1)
      try {
        console.log(
          '[safeParse] Trying extracted JSON, length:',
          extracted.length,
        )
        return JSON.parse(extracted)
      } catch (err2) {
        console.log(
          '[safeParse] Extracted parse also failed:',
          (err2 as Error).message,
        )

        // PARTIAL ANSWER HANDLING: Try to extract partial sentences array
        if (allowPartial) {
          console.log('[safeParse] Attempting partial extraction...')
          const sentencesMatch = text.match(/"sentences"\s*:\s*\[([^\]]*)/)
          if (sentencesMatch) {
            // Extract individual sentence strings
            const sentencesText = sentencesMatch[1]
            const sentences: string[] = []
            const sentenceMatches = sentencesText.matchAll(/"([^"]+)"/g)
            for (const match of sentenceMatches) {
              sentences.push(match[1])
            }
            if (sentences.length > 0) {
              console.log(
                `[safeParse] ✅ Extracted ${sentences.length} partial sentences`,
              )
              return { sentences, _partial: true }
            }
          }
        }
      }
    }
    console.log('[safeParse] Returning empty object')
    return {}
  }
}

// Check if a sentence appears to be a direct quote from the documents
// Much more conservative - only catches obvious verbatim quotes
function detectVerbatimCopying(sentences: string[], docs: any[]): boolean {
  for (const sentence of sentences) {
    if (sentence.length < 50) continue // Skip short sentences

    // Check each source document
    for (const doc of docs) {
      const snippet = String(doc.kps?.[0]?.snippet || '')
      if (!snippet || snippet.length < 50) continue

      // Normalize both for comparison (keep punctuation to detect exact quotes)
      const sentNorm = sentence.trim().toLowerCase()
      const snippetNorm = snippet.trim().toLowerCase()

      // Check if the sentence is a substring of the snippet (exact quote)
      if (snippetNorm.includes(sentNorm) || sentNorm.includes(snippetNorm)) {
        console.warn(`Detected exact quote from source`)
        return true
      }

      // Check for very long verbatim sequences (20+ words)
      // This catches quotes with minor modifications
      const sentWords = sentNorm.replace(/[^\w\s]/g, '').split(/\s+/)
      const snippetWords = snippetNorm.replace(/[^\w\s]/g, '').split(/\s+/)

      for (let i = 0; i <= sentWords.length - 20; i++) {
        const longPhrase = sentWords.slice(i, i + 20).join(' ')
        const snippetText = snippetWords.join(' ')
        if (snippetText.includes(longPhrase)) {
          console.warn(`Detected 20+ word verbatim sequence`)
          return true
        }
      }
    }
  }
  return false
}

async function runNanoFilter(
  query: string,
  docs: Array<{ id: number; title: string; key_finding: string }>,
  provider: { baseUrl: string; apiKey: string },
): Promise<{
  relevance: Array<{ id: number; tier: string }>
  coverage: string
} | null> {
  try {
    // Shuffle docs to prevent position bias (Fisher-Yates)
    const shuffled = [...docs]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }

    const passageText = shuffled
      .map((d) => `[${d.id}] "${d.title}" — ${d.key_finding}`)
      .join('\n\n')

    const userPrompt = `Question: ${query}\n\nPassages (presented in random order):\n${passageText}`

    const isNanoGPT5 = /^gpt-5/i.test(NANO_MODEL)
    const body: any = {
      model: NANO_MODEL,
      messages: [
        { role: 'system', content: NANO_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }
    if (isNanoGPT5) {
      body.max_completion_tokens = 500
    } else {
      body.max_tokens = 500
      body.temperature = 0.1
    }

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
    const parsed = safeParse(content, false)

    if (!Array.isArray(parsed.relevance)) {
      console.error('[Nano Filter] Invalid response structure')
      return null
    }

    const coverage = ['good', 'limited', 'poor'].includes(parsed.coverage)
      ? parsed.coverage
      : 'limited'

    return { relevance: parsed.relevance, coverage }
  } catch (err) {
    console.error('[Nano Filter] Error:', err)
    return null
  }
}

export async function POST(req: NextRequest) {
  const debugInfo: any = { timestamp: new Date().toISOString() }

  try {
    const reqBody = await req.json()
    const { query, docs } = reqBody

    // Debug: Log what we received
    debugInfo.received = {
      hasQuery: !!query,
      queryLength: query?.length || 0,
      docsCount: Array.isArray(docs) ? docs.length : 0,
      docsStructure: Array.isArray(docs)
        ? docs.slice(0, 2).map((d: any) => ({
            hasTitle: !!d?.title,
            hasKps: !!d?.kps,
            kpsCount: Array.isArray(d?.kps) ? d.kps.length : 0,
            firstSnippetLength: d?.kps?.[0]?.snippet?.length || 0,
          }))
        : 'not-array',
    }

    console.log(
      '[Answer Route] Received:',
      JSON.stringify(debugInfo.received, null, 2),
    )

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

    // Run nano relevance filter (gated — enable with USE_NANO_FILTER=true)
    const nanoResult = USE_NANO_FILTER
      ? await runNanoFilter(
          query,
          docList.map((d) => ({
            id: d.id,
            title: d.title,
            key_finding: d.key_finding,
          })),
          { baseUrl: cfg.baseUrl, apiKey: key },
        )
      : null

    let filteredDocs: typeof docList
    let coverageRating: string = 'unknown'
    let sourceRelevanceFromNano: Array<{ doc_id: string; tier: string }> = []

    if (nanoResult) {
      const tierMap = new Map<number, string>()
      for (const r of nanoResult.relevance) {
        tierMap.set(r.id, r.tier)
      }

      // Filter: keep strong + partial, drop weak
      filteredDocs = docList.filter((d) => {
        const tier = tierMap.get(d.id) || 'weak'
        return tier === 'strong' || tier === 'partial'
      })

      // Build source_relevance for frontend (all docs, not just filtered)
      sourceRelevanceFromNano = docList
        .map((d) => ({
          doc_id: d.doc_id,
          tier: tierMap.get(d.id) || 'weak',
        }))
        .filter((sr) => sr.doc_id)

      coverageRating = nanoResult.coverage
      const maxDocs = cfg.maxPassages
      filteredDocs = filteredDocs.slice(0, maxDocs)

      console.log(
        `[Nano Filter] ${docList.length} → ${filteredDocs.length} docs (coverage: ${coverageRating})`,
      )

      // Edge case: all weak → skip synthesis, return low coverage
      if (filteredDocs.length === 0) {
        return NextResponse.json({
          ok: true,
          synthesis: {
            sentences: [
              'The available sources do not contain sufficient information to answer this question.',
            ],
            source_relevance: sourceRelevanceFromNano,
            warning: 'low_coverage',
            warningMessage:
              'The available sources do not adequately cover this topic.',
            coverage: coverageRating,
          },
          passages_sent: [],
          debug: {
            ...debugInfo,
            nanoFilter: 'all_weak',
            coverage: coverageRating,
          },
        })
      }
    } else {
      // Nano filter off or failed — use all docs capped at maxDocs
      const maxDocs = cfg.maxPassages
      filteredDocs = docList.slice(0, maxDocs)
    }

    const passagesSent = filteredDocs.map((d) => ({
      id: d.id,
      doc_id: d.doc_id,
      chunk_id: d.chunk_id,
      page: d.page,
      text: d.key_finding,
    }))

    debugInfo.docListCreated = {
      count: filteredDocs.length,
      totalBeforeFilter: docList.length,
      hasContent: filteredDocs.some((d) => d.key_finding.length > 0),
      coverage: coverageRating,
    }

    console.log('[Answer Route] DocList created:', debugInfo.docListCreated)

    // Create a structured prompt that frames the task clearly
    const coverageNote = cfg.likelyOffTopic
      ? `\n\nCoverage check: the question's core topic appears to be absent from this corpus. If the sources do not actually answer it, return the low_coverage response.`
      : ''
    const userContent = `Question: ${query}

Source documents with key findings:
${filteredDocs
  .map(
    (d) =>
      `[${d.id}] "${d.title}" (${d.year || 'n.d.'})
   Key finding: ${d.key_finding}`,
  )
  .join('\n\n')}

Task: Evaluate each source's relevance, then write exactly 2-3 clear sentences synthesizing the most important information from the relevant sources. Focus on breadth - touch on multiple key findings rather than elaborating on one.${coverageNote}`

    const messages = [
      {
        role: 'system',
        content: cfg.promptVersion === 'v1' ? SYS_V1 : SYS_V2,
      },
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

    console.log('[Answer Route] Calling OpenAI:', debugInfo.apiCall)

    const r = await chatCompletion({
      baseUrl: cfg.baseUrl,
      apiKey: key,
      body: apiBody,
    })
    const json: any = r.json

    const finishReason = json?.choices?.[0]?.finish_reason
    const content = json?.choices?.[0]?.message?.content ?? ''

    debugInfo.apiResponse = {
      status: r.status,
      ok: r.ok,
      hasChoices: !!json?.choices?.length,
      finishReason,
      contentLength: content.length,
      wasTruncated: finishReason === 'length',
    }

    console.log('[Answer Route] OpenAI response:', debugInfo.apiResponse)

    if (!r.ok) {
      console.log(
        '[Answer Route] API call failed, using fallback. Error:',
        json,
      )
      debugInfo.fallbackReason = 'api_error'
      debugInfo.apiError = json
      return NextResponse.json({
        ok: true,
        synthesis: synthFallback(query, docs),
        passages_sent: passagesSent,
        debug: { ...debugInfo, used, status: r.status, upstream: json },
      })
    }

    // TRUNCATION DETECTION: Check if response was cut off
    const wasTruncated = finishReason === 'length'
    if (wasTruncated) {
      console.warn('[Answer Route] ⚠️  Response truncated by token limit!')
      debugInfo.truncationDetected = true
    }

    // Enable partial extraction if truncated
    const parsed = safeParse(content, wasTruncated)

    // Enhanced debug info for both formats
    const hasParagraphs = Array.isArray(parsed.paragraphs)
    const hasSentences = Array.isArray(parsed.sentences)
    const isPartial = parsed._partial === true

    debugInfo.parsing = {
      contentReceived: content.length > 0,
      contentPreview: content.slice(0, 100),
      hasParagraphs,
      hasSentences,
      paragraphsType: hasParagraphs ? typeof parsed.paragraphs[0] : undefined,
      paragraphsCount: hasParagraphs ? parsed.paragraphs.length : 0,
      parsedSuccessfully: hasParagraphs || hasSentences,
      sentenceCount: Array.isArray(parsed.sentences)
        ? parsed.sentences.length
        : 0,
    }

    console.log(
      '[Answer Route] Parsing result:',
      JSON.stringify(debugInfo.parsing, null, 2),
    )
    console.log(
      '[Answer Route] Paragraphs structure:',
      hasParagraphs
        ? JSON.stringify(parsed.paragraphs.slice(0, 2), null, 2)
        : 'none',
    )

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

    // Check for verbatim copying but don't override the response
    const hasQuotes = detectVerbatimCopying(sentences, docs)

    // Build synthesis response with appropriate warnings
    const synthesis: any = { sentences, cites }

    // Source relevance: prefer nano filter tiers (absolute), fall back to synthesis LLM tiers
    let sourceRelevance: Array<{ doc_id: string; tier: string }> = []
    if (sourceRelevanceFromNano.length > 0) {
      sourceRelevance = sourceRelevanceFromNano
    } else {
      const rawSourceRelevance: { id: number; tier: string }[] = Array.isArray(
        parsed.source_relevance,
      )
        ? parsed.source_relevance
        : []
      sourceRelevance = rawSourceRelevance
        .map((sr) => {
          const doc = docList[sr.id - 1]
          return {
            doc_id: doc?.doc_id || '',
            tier: sr.tier || 'weak',
          }
        })
        .filter((sr) => sr.doc_id)
    }
    if (sourceRelevance.length > 0) {
      synthesis.source_relevance = sourceRelevance
    }
    if (coverageRating && coverageRating !== 'unknown') {
      synthesis.coverage = coverageRating
    }

    // Low coverage: from nano filter or synthesis LLM
    const isLowCoverage =
      cfg.likelyOffTopic ||
      coverageRating === 'poor' ||
      coverageRating === 'limited' ||
      parsed.low_coverage === true
    const sourcesUsed = filteredDocs.length

    if (isLowCoverage) {
      synthesis.warning = 'low_coverage'
      synthesis.warningMessage =
        'Limited relevant sources found for this query. The answer may not fully address your question.'
      console.warn(
        `[Answer Route] Low coverage: sources_used=${sourcesUsed}/${docList.length}`,
      )
    } else if (sourcesUsed < 3 && docList.length >= 3) {
      synthesis.warning = 'low_coverage'
      synthesis.warningMessage =
        'Only a few sources were relevant to this query. The answer may be incomplete.'
      console.warn(
        `[Answer Route] Low coverage: sources_used=${sourcesUsed}/${docList.length}`,
      )
    } else if (isPartial || wasTruncated) {
      synthesis.warning = 'partial_answer'
      synthesis.warningMessage =
        'Answer may be incomplete due to length constraints. Consider refining your query.'
      console.warn('[Answer Route] Returning partial answer with warning')
    } else if (hasQuotes) {
      synthesis.warning = 'possible_quotes'
      synthesis.warningMessage =
        'Answer may contain direct quotes from sources.'
      console.warn('[Answer Route] Quote detection triggered')
    }

    debugInfo.success = true
    debugInfo.warnings = {
      isPartial,
      wasTruncated,
      hasQuotes,
      isLowCoverage,
      sourcesUsed,
      totalDocs: docList.length,
    }

    return NextResponse.json({
      ok: true,
      synthesis,
      passages_sent: passagesSent,
      debug: debugInfo,
    })
  } catch (error: any) {
    console.error('[Answer Route] Exception:', error)
    debugInfo.exception = error?.message || String(error)
    debugInfo.fallbackReason = 'exception'
    return NextResponse.json({
      ok: true,
      synthesis: {
        sentences: [
          'Could not synthesize a full answer from the provided context.',
        ],
      },
      passages_sent: [],
      debug: debugInfo,
    })
  }
}
