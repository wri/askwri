/* eslint-disable */

import { NextRequest, NextResponse } from 'next/server'
import { isEnglishText } from '@/lib/ensure-english'
import { resolveRouteModel, type RouteProvenance } from '@/lib/route-model'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

// Read at import: this is the route's own default, used whenever the request
// names no model. A requested model is resolved per request in POST.
const FALLBACK_MODEL = (
  process.env.OPENAI_MODEL_WHY ??
  process.env.OPENAI_MODEL ??
  'gpt-4o-mini'
).trim()

const CANNED_WHY = 'This passage provides relevant context for the query.'

// This route answers 200 with canned sentences on a parse failure, on a short
// answer and on every row the English guard replaces, so `produced`/`sanitized`
// are what keep a response no model authored from reading as evidence;
// `fallback_reason` names the cause.
function provenance(
  model: string,
  produced: boolean,
  fallbackReason?: string,
): RouteProvenance {
  return {
    model,
    produced,
    ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
  }
}

// Calculate optimal token allocation based on content and model
function calculateOptimalTokens(passages: any[], model: string): number {
  const isGPT5 = model.includes('gpt-5') || model === 'gpt-5-mini'

  // Simplified calculation optimized for pagination (20-30 passages per call)
  // Base overhead + ~80 tokens per passage for JSON structure
  const calculatedTokens = 200 + passages.length * 80

  // Cap at reasonable maximum - increased to handle 20-30 passages per page
  // Note: gpt-4o-mini supports up to 16k output tokens
  const maxTokens = isGPT5 ? 3000 : 2500

  console.log(
    `[batch-why] Token calculation: ${passages.length} passages -> ${calculatedTokens} tokens (capped at ${maxTokens})`,
  )

  return Math.min(calculatedTokens, maxTokens)
}

// Parameter configuration for different model families
function getModelParams(model: string, tokenCount: number) {
  const isGPT5 = model.includes('gpt-5') || model === 'gpt-5-mini'
  const isGPT4o = model.includes('gpt-4o')
  const isO1 = model.includes('o1')

  if (isGPT5) {
    // GPT-5 models use max_completion_tokens, skip reasoning_effort for reliable JSON
    return {
      max_completion_tokens: tokenCount,
      // Removed reasoning_effort for batch processing to ensure reliable JSON output
    }
  } else if (isO1) {
    // o1 models use max_completion_tokens, no temperature, no system messages
    return {
      max_completion_tokens: tokenCount,
    }
  } else if (isGPT4o) {
    // GPT-4o models use max_completion_tokens and support temperature
    return {
      max_completion_tokens: tokenCount,
      temperature: 0.3,
    }
  } else {
    // Older models (gpt-3.5-turbo, gpt-4) use max_tokens
    return {
      max_tokens: tokenCount,
      temperature: 0.3,
    }
  }
}

export async function POST(req: NextRequest) {
  console.log('[batch-why] API called')

  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) {
    console.error('[batch-why] No API key configured')
    return NextResponse.json(
      {
        error: 'OPENAI_API_KEY not configured',
        provenance: provenance(FALLBACK_MODEL, false, 'no_api_key'),
      },
      { status: 500 },
    )
  }

  // The model this response is about, for the catch-all below that cannot
  // re-read the request body.
  let model = FALLBACK_MODEL

  try {
    const body = await req.json()
    console.log('[batch-why] Request body:', body)

    const { query, passages, mode } = body

    const resolved = resolveRouteModel(req, body, FALLBACK_MODEL)
    if (!resolved.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: resolved.error,
          provenance: provenance(
            FALLBACK_MODEL,
            false,
            'model_override_rejected',
          ),
        },
        { status: 400 },
      )
    }
    model = resolved.model

    if (!query || !passages || !Array.isArray(passages)) {
      console.error('[batch-why] Invalid request format:', {
        query: !!query,
        passages: !!passages,
        isArray: Array.isArray(passages),
      })
      return NextResponse.json(
        {
          error: 'Invalid request format',
          provenance: provenance(model, false, 'no_docs'),
        },
        { status: 400 },
      )
    }

    console.log('[batch-why] Processing:', {
      model,
      passageCount: passages.length,
      query,
    })

    const isAnswerMode = mode === 'answer'
    const promptTitle = isAnswerMode ? 'Why Relevant' : 'How It Relates'

    // Create batch prompt for all passages
    const systemPrompt = `You must return a JSON array explaining why each passage is relevant to the query.

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

    // Smart truncation based on total content volume
    const totalLength = passages.reduce(
      (sum, p) => sum + (p.snippet?.length || 0),
      0,
    )
    const maxPerSnippet = totalLength > 2000 ? 200 : 300 // Aggressive truncation for large batches

    const passageList = passages
      .map((p: any, i: number) => {
        const snippet = p.snippet || ''
        const truncatedSnippet =
          snippet.length > maxPerSnippet
            ? snippet.slice(0, maxPerSnippet) + '...'
            : snippet
        return `**Passage ${i + 1}** (from "${p.docTitle}"):\n${truncatedSnippet}\n`
      })
      .join('\n')

    const isO1Model = model.includes('o1')

    // For o1 models, combine system and user prompts since they don't support system messages
    const userPrompt = isO1Model
      ? `${systemPrompt}\n\nQuery: "${query}"\n\n${passageList}\n\nExplain why each passage is relevant to this query:`
      : `Query: "${query}"\n\n${passageList}\n\nExplain why each passage is relevant to this query:`

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: isO1Model
          ? [{ role: 'user', content: userPrompt }] // o1 models don't support system messages
          : [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
        ...getModelParams(model, calculateOptimalTokens(passages, model)), // Dynamic allocation
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[batch-why] OpenAI API error:', response.status, errorText)
      return NextResponse.json(
        {
          error: `OpenAI API error: ${response.status} - ${errorText}`,
          provenance: provenance(model, false, `upstream_${response.status}`),
        },
        { status: 500 },
      )
    }

    const data = await response.json()

    console.log(
      '[batch-why] Full OpenAI response:',
      JSON.stringify(data, null, 2),
    )

    // For gpt-5-mini, the content might be in a different location when reasoning is used
    let content = ''

    if (data.choices?.[0]?.message?.content) {
      content = data.choices[0].message.content.trim()
    } else if (data.choices?.[0]?.text) {
      content = data.choices[0].text.trim()
    } else if (data.text) {
      content = data.text.trim()
    } else if (data.content) {
      content = data.content.trim()
    }

    console.log('[batch-why] Final extracted content:', {
      content: content.slice(0, 200),
      contentLength: content.length,
      source: data.choices?.[0]?.message?.content
        ? 'message.content'
        : 'alternative',
      isEmpty: content === '',
    })

    try {
      // Try to extract JSON from the content (sometimes wrapped in markdown)
      let jsonContent = content

      // Remove markdown code blocks if present
      const jsonMatch = content.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/)
      if (jsonMatch) {
        jsonContent = jsonMatch[1]
      }

      const parsed = JSON.parse(jsonContent)

      if (!Array.isArray(parsed)) {
        throw new Error('Response is not an array')
      }

      // `sanitized` means the response carries text the model did not write:
      // a passage the model never answered (padding) or one whose mirrored
      // output the English guard replaced (issue #387: the model sometimes
      // mirrors Chinese passages despite the prompt rule). `written` counts the
      // explanations that came from the model at all.
      let sanitized = false
      let written = 0
      const explanations = passages.map((_p: any, i: number) => {
        const exp = parsed[i]
        const why = typeof exp?.why === 'string' ? exp.why.trim() : ''
        if (!why) {
          sanitized = true
          return { why: CANNED_WHY, relation: 'indirect' as const }
        }
        written += 1
        if (!isEnglishText(why)) {
          sanitized = true
          return { why: CANNED_WHY, relation: 'indirect' as const }
        }
        return exp
      })

      console.log('[batch-why] Successfully parsed explanations:', {
        count: explanations.length,
        written,
        sanitized,
        explanations: explanations.map((exp, i) => ({
          index: i,
          why: exp.why?.slice(0, 100) + '...',
          relation: exp.relation,
          hasWhy: !!exp.why,
          whyLength: exp.why?.length || 0,
        })),
      })

      // "[]" parses, and an all-substituted answer covers every passage with
      // canned text: neither carries a single word the model wrote, so report
      // it as the parse failure it is rather than as model output.
      if (written === 0) {
        return NextResponse.json({
          ok: true,
          explanations,
          usage: data.usage,
          debug: { parseError: true },
          provenance: provenance(model, false, 'parse_error'),
        })
      }

      return NextResponse.json({
        ok: true,
        explanations, // one per passage, in order
        usage: data.usage,
        debug: { rawContent: content.slice(0, 200) },
        provenance: {
          ...provenance(model, true),
          ...(sanitized ? { sanitized: true } : {}),
        },
      })
    } catch (parseError: any) {
      console.error('[batch-why] JSON parsing failed:', {
        error: parseError,
        rawContent: content,
        model,
      })

      // Fallback: create generic explanations if JSON parsing fails
      const fallbackExplanations = passages.map(() => ({
        why: CANNED_WHY,
        relation: 'indirect' as const,
      }))

      return NextResponse.json({
        ok: true,
        explanations: fallbackExplanations,
        usage: data.usage,
        fallback: true,
        debug: {
          parseError: parseError.message,
          rawContent: content.slice(0, 200),
        },
        provenance: provenance(model, false, 'parse_error'),
      })
    }
  } catch (error: any) {
    console.error('[batch-why] Error:', error.message)
    return NextResponse.json(
      {
        error: error.message,
        provenance: provenance(model, false, 'error'),
      },
      { status: 500 },
    )
  }
}
