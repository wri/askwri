/* eslint-disable */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const MODEL = (
  process.env.OPENAI_MODEL_WHY ??
  process.env.OPENAI_MODEL ??
  'gpt-4o-mini'
).trim()
const IS_GPT5 = /^gpt-5/i.test(MODEL)
// GPT-5 needs much higher token limits due to reasoning tokens
const DEFAULT_MAX = IS_GPT5 ? 1000 : 150
const ENV_MAX = Number(process.env.OPENAI_MAX_TOKENS || DEFAULT_MAX)
const MAX = IS_GPT5 ? Math.max(1000, ENV_MAX) : ENV_MAX
const TEMP = Number(process.env.OPENAI_TEMPERATURE ?? 0.2)

const SYS = `
You generate ONE concise sentence explaining why a cited passage answers the user's query.

Rules:
- Output STRICT JSON ONLY: {"why":"...", "relation":"direct"|"indirect"}
- Do NOT restate the query.
- Do NOT use generic phrases like "by showing evidence/mechanism".
- Be specific and terse (≤ 18 words).
- relation = "direct" if the passage explicitly answers; otherwise "indirect".
`.trim()

function fallbackWhy(snippet: string) {
  // Fallback: clip to a crisp clause, mark as "indirect"
  const s = (snippet || '').split(/[.!?]\s/)[0]?.trim() || snippet.slice(0, 120)
  return {
    why: s || 'Relevant supporting evidence.',
    relation: 'indirect' as const,
  }
}

function safeParse(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    const s = text.indexOf('{')
    const e = text.lastIndexOf('}')
    if (s !== -1 && e !== -1 && e > s) {
      try {
        return JSON.parse(text.slice(s, e + 1))
      } catch {}
    }
    return {}
  }
}

export async function POST(req: NextRequest) {
  const debugInfo: any = {
    timestamp: new Date().toISOString(),
    endpoint: 'why',
  }

  try {
    const { query, doc } = await req.json()
    const key = process.env.OPENAI_API_KEY?.trim()
    const bestSnippet = String(doc?.snippet ?? '').slice(0, 700)

    // Debug: Log environment and model selection
    debugInfo.env = {
      OPENAI_MODEL: process.env.OPENAI_MODEL,
      OPENAI_MODEL_WHY: process.env.OPENAI_MODEL_WHY,
      selectedModel: MODEL,
      isGPT5: IS_GPT5,
      maxTokens: MAX,
      temperature: TEMP,
    }
    console.log('[Why Route] Config:', JSON.stringify(debugInfo.env, null, 2))

    if (!key) {
      const fb = fallbackWhy(bestSnippet)
      return NextResponse.json({ ok: true, why: fb.why, relation: fb.relation })
    }

    const payload = {
      query, // present for context only; the prompt prohibits restating it
      doc: {
        title: doc?.title,
        authors: doc?.authors,
        year: doc?.year,
        top_snippet: bestSnippet,
      },
    }

    // Model-aware Chat Completions
    const body: any = {
      model: MODEL,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      ...(IS_GPT5
        ? {
            max_completion_tokens: MAX,
            reasoning_effort: 'medium', // Add reasoning for better quality explanations
          }
        : {
            max_tokens: MAX,
            temperature: TEMP,
          }),
    }

    // Debug: Log what we're sending to OpenAI
    debugInfo.apiCall = {
      model: body.model,
      hasMaxCompletionTokens: 'max_completion_tokens' in body,
      hasMaxTokens: 'max_tokens' in body,
      actualMaxTokens: body.max_completion_tokens || body.max_tokens,
      temperature: body.temperature,
      systemPromptLength: SYS.length,
      userContentLength: JSON.stringify(payload).length,
    }
    console.log(
      '[Why Route] API Call:',
      JSON.stringify(debugInfo.apiCall, null, 2),
    )

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const raw = await r.text()
    let j: any
    try {
      j = JSON.parse(raw)
    } catch {
      j = { raw }
    }

    // Debug: Log response details
    debugInfo.apiResponse = {
      status: r.status,
      ok: r.ok,
      model_used: j?.model,
      finish_reason: j?.choices?.[0]?.finish_reason,
      usage: j?.usage,
      contentLength: j?.choices?.[0]?.message?.content?.length || 0,
      contentPreview: j?.choices?.[0]?.message?.content?.slice(0, 100),
    }
    console.log(
      '[Why Route] API Response:',
      JSON.stringify(debugInfo.apiResponse, null, 2),
    )

    if (!r.ok) {
      const fb = fallbackWhy(bestSnippet)
      return NextResponse.json({
        ok: true,
        why: fb.why,
        relation: fb.relation,
        debug: { status: r.status, upstream: j?.error },
      })
    }

    // Extract JSON from content/parsed/tool_calls
    const choice = j?.choices?.[0]
    const msg = choice?.message || {}
    let content = ''
    if (typeof msg.content === 'string' && msg.content.trim())
      content = msg.content
    else if (msg.parsed && typeof msg.parsed === 'object')
      content = JSON.stringify(msg.parsed)
    else if (
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls[0]?.function?.arguments
    )
      content = String(msg.tool_calls[0].function.arguments)

    const parsed = safeParse(content)
    const why =
      typeof parsed?.why === 'string' && parsed.why.trim()
        ? parsed.why.trim()
        : null
    const relation =
      parsed?.relation === 'direct' || parsed?.relation === 'indirect'
        ? parsed.relation
        : null

    if (!why || !relation) {
      const fb = fallbackWhy(bestSnippet)
      debugInfo.fallbackReason = 'no_valid_json'
      debugInfo.parsedContent = parsed
      debugInfo.rawContent = content
      return NextResponse.json({
        ok: true,
        why: fb.why,
        relation: fb.relation,
        debug: debugInfo,
      })
    }

    debugInfo.success = true
    return NextResponse.json({ ok: true, why, relation, debug: debugInfo })
  } catch (e: any) {
    const fb = fallbackWhy('')
    return NextResponse.json({
      ok: true,
      why: fb.why,
      relation: fb.relation,
      debug: { error: String(e?.message || e) },
    })
  }
}
