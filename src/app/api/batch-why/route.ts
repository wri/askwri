/* eslint-disable */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const OPENAI_MODEL = (
  process.env.OPENAI_MODEL_WHY ??
  process.env.OPENAI_MODEL ??
  'gpt-4o-mini'
).trim()

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

  if (!OPENAI_API_KEY) {
    console.error('[batch-why] No API key configured')
    return NextResponse.json(
      { error: 'OPENAI_API_KEY not configured' },
      { status: 500 },
    )
  }

  try {
    const body = await req.json()
    console.log('[batch-why] Request body:', body)

    const { query, passages, mode } = body

    if (!query || !passages || !Array.isArray(passages)) {
      console.error('[batch-why] Invalid request format:', {
        query: !!query,
        passages: !!passages,
        isArray: Array.isArray(passages),
      })
      return NextResponse.json(
        { error: 'Invalid request format' },
        { status: 400 },
      )
    }

    console.log('[batch-why] Processing:', {
      model: OPENAI_MODEL,
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

    const isO1Model = OPENAI_MODEL.includes('o1')

    // For o1 models, combine system and user prompts since they don't support system messages
    const userPrompt = isO1Model
      ? `${systemPrompt}\n\nQuery: "${query}"\n\n${passageList}\n\nExplain why each passage is relevant to this query:`
      : `Query: "${query}"\n\n${passageList}\n\nExplain why each passage is relevant to this query:`

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: isO1Model
          ? [{ role: 'user', content: userPrompt }] // o1 models don't support system messages
          : [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
        ...getModelParams(
          OPENAI_MODEL,
          calculateOptimalTokens(passages, OPENAI_MODEL),
        ), // Dynamic allocation
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`)
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

      const explanations = JSON.parse(jsonContent)

      if (!Array.isArray(explanations)) {
        throw new Error('Response is not an array')
      }

      // Pad with fallbacks if we got fewer explanations than expected
      while (explanations.length < passages.length) {
        explanations.push({
          why: 'This passage provides relevant context for the query.',
          relation: 'indirect',
        })
      }

      console.log('[batch-why] Successfully parsed explanations:', {
        count: explanations.length,
        explanations: explanations.map((exp, i) => ({
          index: i,
          why: exp.why?.slice(0, 100) + '...',
          relation: exp.relation,
          hasWhy: !!exp.why,
          whyLength: exp.why?.length || 0,
        })),
      })

      return NextResponse.json({
        ok: true,
        explanations: explanations.slice(0, passages.length), // Ensure exact match
        usage: data.usage,
        debug: { rawContent: content.slice(0, 200) },
      })
    } catch (parseError: any) {
      console.error('[batch-why] JSON parsing failed:', {
        error: parseError,
        rawContent: content,
        model: OPENAI_MODEL,
      })

      // Fallback: create generic explanations if JSON parsing fails
      const fallbackExplanations = passages.map(() => ({
        why: 'This passage provides relevant context for the query.',
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
      })
    }
  } catch (error: any) {
    console.error('[batch-why] Error:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
