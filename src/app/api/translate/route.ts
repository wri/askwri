/**
 * On-demand English translation of a single retrieved passage (issue #305).
 *
 * Scoped deliberately narrow: the excerpt shown in the answer-mode citation
 * card, translated only when the reader asks. Retrieval is untouched — the
 * search-service has its own query-side translator (app/query_translate.py)
 * for the sparse lane and this shares nothing with it.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requestProfile, wireParams } from '@/lib/request-profile'
import { resolveModel } from '@/config/models'
import { resolveRouteModel, type RouteProvenance } from '@/lib/route-model'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

// Read at import: this is the route's own default, used whenever the request
// names no model. A requested model is resolved per request in POST.
const FALLBACK_MODEL = resolveModel('translate')
const MAX_INPUT_CHARS = 4000

// `produced: false` is what keeps a response that no model authored from
// reading as evidence; `fallback_reason` names the cause.
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
You translate excerpts from research publications into English.

Rules:
- Return ONLY the English translation, with no preamble, notes or quotation marks.
- Preserve the meaning, register and paragraph breaks of the source.
- Keep numbers, units, dates and proper nouns intact.
- The excerpt may include markers like **[ ... ]** around the retrieved passage;
  keep those markers exactly where they are.
- If the text is already in English, return it unchanged.
`.trim()

export async function POST(req: NextRequest) {
  // The model this response is about, for the catch-all below that cannot
  // re-read the request body.
  let model: string = FALLBACK_MODEL
  try {
    const body = (await req.json()) as { text?: string; model?: string }
    const source = String(body?.text ?? '').trim()

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

    if (!source) {
      return NextResponse.json(
        {
          ok: false,
          error: 'text is required',
          provenance: provenance(model, false, 'no_text'),
        },
        { status: 400 },
      )
    }

    const key = process.env.OPENAI_API_KEY?.trim()
    if (!key) {
      return NextResponse.json(
        {
          ok: false,
          error: 'OPENAI_API_KEY not configured',
          provenance: provenance(model, false, 'no_api_key'),
        },
        { status: 500 },
      )
    }

    // A passage is capped at 800 chars upstream (search-service main.py); the
    // translation can run longer than the source, and GPT-5 spends reasoning
    // tokens out of the same budget. Sized from the model actually being asked.
    const profile = requestProfile({
      task: 'translate',
      model,
      attempt: 'primary',
      input: {},
    })

    const payload: any = {
      model,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: source.slice(0, MAX_INPUT_CHARS) },
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

    const j = await r.json().catch(() => null)

    if (!r.ok) {
      console.error('[translate] OpenAI error:', r.status, j?.error?.message)
      return NextResponse.json(
        {
          ok: false,
          error: 'Translation service unavailable',
          provenance: provenance(model, false, `upstream_${r.status}`),
        },
        { status: 502 },
      )
    }

    const translation = String(j?.choices?.[0]?.message?.content ?? '').trim()
    if (!translation) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Empty translation',
          provenance: provenance(model, false, 'empty_translation'),
        },
        { status: 502 },
      )
    }

    return NextResponse.json({
      ok: true,
      translation,
      model,
      provenance: provenance(model, true),
    })
  } catch (error: any) {
    console.error('[translate] Error:', error?.message)
    return NextResponse.json(
      {
        ok: false,
        error: 'Internal server error',
        provenance: provenance(model, false, 'error'),
      },
      { status: 500 },
    )
  }
}
