/**
 * On-demand English translation of a single retrieved passage (issue #305).
 *
 * Scoped deliberately narrow: the excerpt shown in the answer-mode citation
 * card, translated only when the reader asks. Retrieval is untouched — the
 * search-service has its own query-side translator (app/query_translate.py)
 * for the sparse lane and this shares nothing with it.
 */
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const MODEL = (
  process.env.OPENAI_MODEL_TRANSLATE ??
  process.env.OPENAI_MODEL ??
  'gpt-5-mini'
).trim()
const IS_GPT5 = /^gpt-5/i.test(MODEL)
// A passage is capped at 800 chars upstream (search-service main.py); the
// translation can run longer than the source, and GPT-5 spends reasoning
// tokens out of the same budget.
const MAX_TOKENS = IS_GPT5 ? 2000 : 1200
const MAX_INPUT_CHARS = 4000

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
  try {
    const { text } = (await req.json()) as { text?: string }
    const source = String(text ?? '').trim()

    if (!source) {
      return NextResponse.json(
        { ok: false, error: 'text is required' },
        { status: 400 },
      )
    }

    const key = process.env.OPENAI_API_KEY?.trim()
    if (!key) {
      return NextResponse.json(
        { ok: false, error: 'OPENAI_API_KEY not configured' },
        { status: 500 },
      )
    }

    const body: any = {
      model: MODEL,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: source.slice(0, MAX_INPUT_CHARS) },
      ],
      ...(IS_GPT5
        ? { max_completion_tokens: MAX_TOKENS }
        : { max_tokens: MAX_TOKENS, temperature: 0.2 }),
    }

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const j = await r.json().catch(() => null)

    if (!r.ok) {
      console.error('[translate] OpenAI error:', r.status, j?.error?.message)
      return NextResponse.json(
        { ok: false, error: 'Translation service unavailable' },
        { status: 502 },
      )
    }

    const translation = String(j?.choices?.[0]?.message?.content ?? '').trim()
    if (!translation) {
      return NextResponse.json(
        { ok: false, error: 'Empty translation' },
        { status: 502 },
      )
    }

    return NextResponse.json({ ok: true, translation, model: MODEL })
  } catch (error: any) {
    console.error('[translate] Error:', error?.message)
    return NextResponse.json(
      { ok: false, error: 'Internal server error' },
      { status: 500 },
    )
  }
}
