/* eslint-disable */

import { NextRequest, NextResponse } from 'next/server'
import { isEnglishText } from '@/lib/ensure-english'
import { requestProfile, wireParams } from '@/lib/request-profile'
import { resolveModel } from '@/config/models'
import { resolveRouteModel, type RouteProvenance } from '@/lib/route-model'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

// Read at import: this is the route's own default, used whenever the request
// names no model. A requested model is resolved per request in POST.
const FALLBACK_MODEL = resolveModel('relates')

// This route answers 200 with canned sentences on every failure, so
// `produced: false` is what keeps a response no model authored from reading as
// evidence; `fallback_reason` names the cause.
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
  // The model this response is about, for the catch-all below that cannot
  // re-read the request body.
  let model: string = FALLBACK_MODEL
  try {
    const body = (await req.json()) as {
      query: string
      docs: DocInput[]
      model?: string
    }
    const { query, docs } = body

    const resolved = resolveRouteModel(req, body, FALLBACK_MODEL, 'relates')
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

    const key = process.env.OPENAI_API_KEY?.trim()

    if (!docs || !Array.isArray(docs) || docs.length === 0) {
      return NextResponse.json({
        ok: true,
        results: [],
        provenance: provenance(model, false, 'no_docs'),
      })
    }

    // If no API key, return fallback for all docs. A passage sentence is
    // not a relevance explanation, so never echo the snippet (issue #359).
    if (!key) {
      const results = docs.map(() => ({
        relates: 'Relevant supporting evidence.',
        relation: 'indirect' as const,
      }))
      return NextResponse.json({
        ok: true,
        results,
        provenance: provenance(model, false, 'no_api_key'),
      })
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

    // Token allocation: ~100 tokens per doc for output. GPT-5 spends reasoning
    // tokens out of the same budget, so it gets the larger floor — sized from the
    // model actually being asked, not the route's default.
    const profile = requestProfile({
      task: 'relates',
      model,
      attempt: 'primary',
      input: { documents: docs.length },
    })

    const payload: any = {
      model,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: userContent },
      ],
      ...wireParams(profile),
    }

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
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
        provenance: provenance(model, false, `upstream_${r.status}`),
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
      // `sanitized` means the response carries text the model did not write:
      // either the English fallback replacing mirrored output (issue #387: the
      // model sometimes mirrors Chinese passages despite the prompt rule) or a
      // row the model never answered (padding below). `written` counts the rows
      // that came from the model at all.
      let sanitized = false
      let written = 0
      // Pad with fallbacks if we got fewer results than docs
      const results = docs.map((doc, i) => {
        const item = parsed[i]
        const relates =
          item && typeof item.relates === 'string' ? item.relates.trim() : ''
        if (!relates) {
          sanitized = true
          return {
            relates: 'Relevant supporting evidence.',
            relation: 'indirect' as const,
          }
        }
        written += 1
        if (isEnglishText(relates)) {
          return {
            relates,
            relation:
              item.relation === 'direct'
                ? ('direct' as const)
                : ('indirect' as const),
          }
        }
        sanitized = true
        return {
          relates: 'Relevant supporting evidence.',
          relation: 'indirect' as const,
        }
      })
      // "[]" parses, and a padded-only answer pads every row: neither carries a
      // single word the model wrote, so report it as the parse failure it is
      // rather than as model output.
      if (written === 0) {
        return NextResponse.json({
          ok: true,
          results,
          debug: { parseError: true },
          provenance: provenance(model, false, 'parse_error'),
        })
      }
      return NextResponse.json({
        ok: true,
        results,
        model,
        usage: j?.usage,
        provenance: {
          ...provenance(model, true),
          ...(sanitized ? { sanitized: true } : {}),
        },
      })
    }

    // Parsing failed — return fallbacks
    const results = docs.map(() => ({
      relates: 'Relevant supporting evidence.',
      relation: 'indirect' as const,
    }))
    return NextResponse.json({
      ok: true,
      results,
      debug: { parseError: true },
      provenance: provenance(model, false, 'parse_error'),
    })
  } catch (e: any) {
    return NextResponse.json({
      ok: true,
      results: [],
      debug: { error: String(e?.message || e) },
      provenance: provenance(model, false, 'error'),
    })
  }
}
