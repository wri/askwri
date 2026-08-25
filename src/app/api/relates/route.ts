/* eslint-disable */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const MODEL = (
  process.env.OPENAI_MODEL_RELATES ??
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
Explain, in ONE terse sentence, how the cited document relates to the user's query.

Rules:
- Output STRICT JSON ONLY: {"relates":"...", "relation":"direct"|"indirect"}
- ALWAYS write "relates" in English, even when the document is in another
  language. Never mirror the document's language.
- Do NOT restate the query.
- Avoid generic filler like "by showing evidence/mechanism".
- Be concrete and ≤ 18 words.
- relation = "direct" if the passage explicitly answers; otherwise "indirect".
`.trim()

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
    endpoint: 'relates',
  }

  try {
    const { query, doc } = await req.json()
    const key = process.env.OPENAI_API_KEY?.trim()
    const snippet = String(doc?.snippet ?? '').slice(0, 700)

    // Debug: Log environment and model selection
    debugInfo.env = {
      OPENAI_MODEL: process.env.OPENAI_MODEL,
      OPENAI_MODEL_RELATES: process.env.OPENAI_MODEL_RELATES,
      selectedModel: MODEL,
      isGPT5: IS_GPT5,
      maxTokens: MAX,
      temperature: TEMP,
    }
    console.log(
      '[Relates Route] Config:',
      JSON.stringify(debugInfo.env, null, 2),
    )
    if (!key) {
      const fb =
        snippet.split(/[.!?]\s/)[0]?.trim() || 'Relevant supporting evidence.'
      return NextResponse.json({ ok: true, relates: fb, relation: 'indirect' })
    }

    const payload = {
      query,
      doc: {
        title: doc?.title,
        authors: doc?.authors,
        year: doc?.year,
        top_snippet: snippet,
      },
    }

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
    }
    console.log(
      '[Relates Route] API Call:',
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
      '[Relates Route] API Response:',
      JSON.stringify(debugInfo.apiResponse, null, 2),
    )

    if (!r.ok) {
      const fb =
        snippet.split(/[.!?]\s/)[0]?.trim() || 'Relevant supporting evidence.'
      return NextResponse.json({
        ok: true,
        relates: fb,
        relation: 'indirect',
        debug: { status: r.status, upstream: j?.error },
      })
    }

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
    const relates =
      typeof parsed?.relates === 'string' && parsed.relates.trim()
        ? parsed.relates.trim()
        : snippet.split(/[.!?]\s/)[0]?.trim() || 'Relevant supporting evidence.'
    const relation =
      parsed?.relation === 'direct' || parsed?.relation === 'indirect'
        ? parsed.relation
        : 'indirect'

    debugInfo.success = true
    debugInfo.parsedRelates = relates
    debugInfo.parsedRelation = relation
    return NextResponse.json({ ok: true, relates, relation, debug: debugInfo })
  } catch (e: any) {
    return NextResponse.json({
      ok: true,
      relates: 'Relevant supporting evidence.',
      relation: 'indirect',
      debug: { error: String(e?.message || e) },
    })
  }
}
