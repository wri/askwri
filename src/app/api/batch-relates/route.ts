/* eslint-disable */

import { NextRequest, NextResponse } from 'next/server'
import { isEnglishText } from '@/lib/ensure-english'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const MODEL = (
  process.env.OPENAI_MODEL_RELATES ??
  process.env.OPENAI_MODEL ??
  'gpt-4o-mini'
).trim()
const IS_GPT5 = /^gpt-5/i.test(MODEL)
const TEMP = Number(process.env.OPENAI_TEMPERATURE ?? 0.2)

const SYS = `
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

function safeParse(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    // Try to extract JSON array from markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/)
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1])
      } catch {}
    }
    // Try to find array in raw text
    const s = text.indexOf('[')
    const e = text.lastIndexOf(']')
    if (s !== -1 && e !== -1 && e > s) {
      try {
        return JSON.parse(text.slice(s, e + 1))
      } catch {}
    }
    return null
  }
}

interface DocInput {
  title?: string
  authors?: string
  year?: string
  snippet?: string
}

export async function POST(req: NextRequest) {
  try {
    const { query, docs } = (await req.json()) as {
      query: string
      docs: DocInput[]
    }
    const key = process.env.OPENAI_API_KEY?.trim()

    if (!docs || !Array.isArray(docs) || docs.length === 0) {
      return NextResponse.json({ ok: true, results: [] })
    }

    // If no API key, return fallback for all docs. A passage sentence is
    // not a relevance explanation, so never echo the snippet (issue #359).
    if (!key) {
      const results = docs.map(() => ({
        relates: 'Relevant supporting evidence.',
        relation: 'indirect' as const,
      }))
      return NextResponse.json({ ok: true, results })
    }

    // Build compact doc list for the prompt
    const docList = docs
      .map((doc, i) => {
        const snippet = String(doc?.snippet ?? '').slice(0, 500)
        return `Doc ${i + 1}: "${doc?.title || 'Untitled'}" (${doc?.authors || 'unknown'}, ${doc?.year || '?'})\nSnippet: ${snippet}`
      })
      .join('\n\n')

    const userContent = JSON.stringify({
      query,
      document_count: docs.length,
      documents: docList,
    })

    // Token allocation: ~100 tokens per doc for output
    const outputTokens = IS_GPT5
      ? Math.max(1000, docs.length * 120)
      : Math.min(docs.length * 120, 4000)

    const body: any = {
      model: MODEL,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: userContent },
      ],
      ...(IS_GPT5
        ? { max_completion_tokens: outputTokens }
        : { max_tokens: outputTokens, temperature: TEMP }),
    }

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

    if (!r.ok) {
      // Fallback on API error: never echo a passage sentence as the
      // "how is this relevant" explanation (issue #359).
      const results = docs.map(() => ({
        relates: 'Relevant supporting evidence.',
        relation: 'indirect' as const,
      }))
      return NextResponse.json({
        ok: true,
        results,
        debug: { status: r.status, upstream: j?.error },
      })
    }

    const choice = j?.choices?.[0]
    const msg = choice?.message || {}
    let content = ''
    if (typeof msg.content === 'string' && msg.content.trim()) {
      content = msg.content
    } else if (msg.parsed && typeof msg.parsed === 'object') {
      content = JSON.stringify(msg.parsed)
    }

    const parsed = safeParse(content)

    if (Array.isArray(parsed)) {
      // Pad with fallbacks if we got fewer results than docs
      const results = docs.map((doc, i) => {
        const item = parsed[i]
        // Issue #387: the model sometimes mirrors Chinese passages despite the
        // prompt rule — replace mirrored output with the English fallback.
        if (
          item &&
          typeof item.relates === 'string' &&
          item.relates.trim() &&
          isEnglishText(item.relates)
        ) {
          return {
            relates: item.relates.trim(),
            relation:
              item.relation === 'direct'
                ? ('direct' as const)
                : ('indirect' as const),
          }
        }
        return {
          relates: 'Relevant supporting evidence.',
          relation: 'indirect' as const,
        }
      })
      return NextResponse.json({ ok: true, results, usage: j?.usage })
    }

    // Parsing failed — return fallbacks
    const results = docs.map(() => ({
      relates: 'Relevant supporting evidence.',
      relation: 'indirect' as const,
    }))
    return NextResponse.json({ ok: true, results, debug: { parseError: true } })
  } catch (e: any) {
    return NextResponse.json({
      ok: true,
      results: [],
      debug: { error: String(e?.message || e) },
    })
  }
}
