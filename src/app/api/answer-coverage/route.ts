// src/app/api/answer-coverage/route.ts
/* eslint-disable */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const MODEL = (
  process.env.OPENAI_MODEL_COVERAGE ??
  process.env.OPENAI_MODEL_WHY ??
  'gpt-5.4-nano'
).trim()

const SYSTEM_PROMPT = `You are a research librarian assessing whether a set of retrieved passages can adequately answer a research question.

Given a question and the titles + opening excerpts of the top retrieved passages, rate corpus coverage:

- "good": Multiple passages directly address the question with specific evidence or data
- "limited": Some passages touch on the topic but lack specific answers or direct evidence
- "poor": Passages are tangentially related at best; the corpus likely does not contain material to answer this question

Respond with JSON only:
{"coverage": "good"|"limited"|"poor", "explanation": "One sentence explaining your assessment."}`

export async function POST(req: NextRequest) {
  try {
    const { query, passages } = await req.json()
    const key = process.env.OPENAI_API_KEY?.trim()

    if (!key || !query || !Array.isArray(passages) || passages.length === 0) {
      return NextResponse.json({ ok: true, coverage: 'unknown', explanation: 'Insufficient data for coverage assessment.' })
    }

    // Format top-5 passages compactly for nano model
    const passageText = passages.slice(0, 5).map((p: any, i: number) =>
      `[${i + 1}] "${p.title}" — ${(p.snippet || '').slice(0, 150)}`
    ).join('\n')

    const userPrompt = `Question: "${query}"\n\nTop retrieved passages:\n${passageText}\n\nRate corpus coverage.`

    const isGPT5 = /^gpt-5/i.test(MODEL)
    const body: any = {
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }
    if (isGPT5) {
      body.max_completion_tokens = 200
    } else {
      body.max_tokens = 200
      body.temperature = 0.1
    }

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    })

    if (!r.ok) {
      console.error(`[Coverage] API error: ${r.status}`)
      return NextResponse.json({ ok: true, coverage: 'unknown', explanation: 'Coverage check failed.' })
    }

    const data = await r.json()
    const content = data.choices?.[0]?.message?.content || ''

    try {
      const cleaned = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
      const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}')
      const parsed = JSON.parse(cleaned.slice(s, e + 1))
      const coverage = ['good', 'limited', 'poor'].includes(parsed.coverage) ? parsed.coverage : 'unknown'
      return NextResponse.json({
        ok: true,
        coverage,
        explanation: parsed.explanation || '',
        model: MODEL,
      })
    } catch {
      console.error('[Coverage] Failed to parse response:', content.slice(0, 200))
      return NextResponse.json({ ok: true, coverage: 'unknown', explanation: 'Could not parse coverage assessment.' })
    }
  } catch (err: any) {
    console.error('[Coverage] Error:', err.message)
    return NextResponse.json({ ok: true, coverage: 'unknown', explanation: 'Coverage check error.' })
  }
}
