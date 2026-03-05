// Route: GET|POST /api/alignment — v12.1
// Root fix: obey model-specific params permanently.
//  • GPT-5 family => use `max_completion_tokens` only (NO `max_tokens`, NO `temperature`, NO experimental fields).
//  • Non-GPT-5 => use `max_tokens` (+ optional temperature).
// Robust JSON pipeline: json_schema → tools(function) → json_object, each built via the param router.
// Compact prompt, meta filtering, rich diagnostics. Uses ALIGNMENT_SYSTEM_PROMPT exactly as defined in config.
/* eslint-disable */

import { NextRequest, NextResponse } from 'next/server'
import {
  ALIGNMENT_SYSTEM_PROMPT,
  ALIGNMENT_MODEL as CFG_MODEL,
  ALIGNMENT_MAX_TOKENS as CFG_MAX_TOKENS,
  ALIGNMENT_TEMPERATURE as CFG_TEMPERATURE,
} from '@/config/alignment'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/* ---------------- Config ---------------- */
const MODEL = (
  process.env.OPENAI_MODEL_ALIGNMENT ??
  process.env.OPENAI_MODEL ??
  CFG_MODEL ??
  'gpt-5-mini'
).trim()
const IS_GPT5 = /^gpt-5/i.test(MODEL)
const BASE_URL = (
  process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
).replace(/\/$/, '')

// Timeouts (scaled; capped) - GPT-5 needs longer timeouts
const DEFAULT_MAIN_MS = IS_GPT5 ? 40000 : 20000
const DEFAULT_REPAIR_MS = IS_GPT5 ? 25000 : 12000
const BASE_MAIN_MS = Number(
  process.env.ALIGNMENT_TIMEOUT_MS_MAIN ?? DEFAULT_MAIN_MS,
)
const BASE_REPAIR_MS = Number(
  process.env.ALIGNMENT_TIMEOUT_MS_REPAIR ?? DEFAULT_REPAIR_MS,
)

// Token caps - increased for GPT-5 reasoning token usage
const ENV_MAX = Number(process.env.OPENAI_MAX_TOKENS ?? CFG_MAX_TOKENS ?? 1500)
const MAIN_MAX = IS_GPT5 ? 4000 : Math.max(1000, Math.min(1500, ENV_MAX))
const REPAIR_MAX = IS_GPT5 ? 5000 : Math.min(MAIN_MAX + 500, 2000)

// Temperature (route will omit for GPT-5 models)
const TEMPERATURE = Number(
  process.env.OPENAI_TEMPERATURE ?? CFG_TEMPERATURE ?? 0.7,
)

/* ---------------- Types ---------------- */
type KP = {
  snippet?: string
  page?: number
  passage_id?: string
  score?: number
}
type Doc = {
  title?: string
  _url?: string
  url?: string
  snippet?: string
  kps?: KP[]
  meta?: any
}
type Assessment = {
  insights: string[]
  confidence: number
}

type TryInfo = {
  label: string
  variant: 'json_schema' | 'tools' | 'json_object' | 'fallback'
  status: number
  durationMs: number
  finishReason?: string
  usage?: any
  rawHead?: string
  rawTail?: string
}

/* ---------------- Utils ---------------- */
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n))
const estimateTokens = (...lens: number[]) =>
  Math.ceil(lens.reduce((s, v) => s + (v || 0), 0) / 4)

function firstSentence(t: string, limit = 220) {
  if (!t) return ''
  const m = t.match(/(.+?[.!?])\s+/)
  const one = m ? m[1] : t
  return one.length > limit ? `${one.slice(0, limit - 1)}…` : one
}

const baseNameFromUrl = (u?: string) => {
  if (!u) return undefined
  try {
    const { pathname } = new URL(u)
    const last = pathname.split('/').filter(Boolean).pop() || ''
    return last
      .replace(/[-_]/g, ' ')
      .replace(/\.[a-z0-9]+$/i, '')
      .trim()
  } catch {
    return undefined
  }
}

const titleFrom = (d: Doc) =>
  d.title ||
  d.meta?.raw?.title ||
  baseNameFromUrl(d._url || d.url) ||
  'Untitled'

const snipFrom = (d: Doc) =>
  String(
    d.kps?.[0]?.snippet ||
      d.snippet ||
      d.meta?.raw?.snippet ||
      d.meta?.raw?.text ||
      '',
  )

/* ---------------- Meta sanitization ---------------- */
const META_PHRASES = [
  'json',
  'schema',
  'response_format',
  'system prompt',
  'developer',
  'instruction',
  'validator',
  'format',
  'model',
  'openai',
  'tool',
  'tools',
  'tool call',
  'tool_calls',
  'app',
  'ui',
  'payload',
  'request',
  'messages',
  'chat completion',
  'parse',
  'parsing',
  'unparseable',
  'formatting',
  'prose',
  'only output',
  'property',
  'properties',
  'key',
  'keys',
  'field',
  'fields',
  'additional properties',
  'required fields',
  'array',
  'arrays',
  'string',
  'strings',
  'number',
  'numeric',
  'boolean',
  'object',
  '0.0–1.0',
  '0.0-1.0',
  '0–1',
  '0-1',
  'scale',
  'range',
  'as a number',
  'numeric scale',
  'confidence value',
]
function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
const META_RE = new RegExp(META_PHRASES.map(escapeRegExp).join('|'), 'i')

function stripMeta(arr: string[], limit: number): string[] {
  const cleaned = (arr || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .filter((s) => !META_RE.test(s))
  // Return up to 'limit' items, don't truncate the text
  return cleaned.slice(0, limit)
}

function sanitizeAssessment(input: Assessment): Assessment {
  const insights = stripMeta(input.insights || [], 5)
  const out: Assessment = {
    insights: insights.length
      ? insights
      : [
          'Unable to assess alignment. Try providing more sources or refining your query.',
        ],
    confidence:
      typeof input.confidence === 'number'
        ? clamp(input.confidence, 0, 1)
        : 0.5,
  }
  return out
}

/* ---------------- HTTP helpers ---------------- */
function withAbort(ms: number) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) }
}
async function fetchWithTimeout(url: string, init: RequestInit, ms: number) {
  const { signal, cancel } = withAbort(ms)
  try {
    return await fetch(url, { ...init, signal })
  } finally {
    cancel()
  }
}

/* ------------- OpenAI call wrapper ------------- */
async function chatOnce(
  apiKey: string,
  body: any,
  ms: number,
  variant: string,
) {
  const t0 = Date.now()
  console.log(`[Alignment] Starting ${variant} call with ${ms}ms timeout`)

  let res
  try {
    res = await fetchWithTimeout(
      `${BASE_URL}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      ms,
    )
  } catch (err: any) {
    const durationMs = Date.now() - t0
    console.error(
      `[Alignment] ${variant} call failed after ${durationMs}ms:`,
      err.message,
    )
    throw err
  }

  const durationMs = Date.now() - t0
  console.log(`[Alignment] ${variant} call completed in ${durationMs}ms`)
  const txt = await res.text()
  let json: any
  try {
    json = JSON.parse(txt)
  } catch {
    json = { raw: txt }
  }

  const choice = json?.choices?.[0] || {}
  const finish = String(choice?.finish_reason || '')
  const msg = choice?.message ?? {}
  const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : []

  if (toolCalls.length > 0) {
    const args = toolCalls[0]?.function?.arguments
    let parsed: any = null
    try {
      parsed = typeof args === 'string' ? JSON.parse(args) : args
    } catch {}
    return {
      ok: res.ok,
      status: res.status,
      durationMs,
      content: args ?? '',
      parsed,
      rawHead: txt.slice(0, 240),
      rawTail: txt.slice(-240),
      finishReason: finish || 'tool_calls',
      usage: json?.usage || null,
    }
  }

  let content = ''
  let parsed: any = null
  if (typeof msg.content === 'string') {
    content = msg.content
  } else if (Array.isArray(msg.content)) {
    content = msg.content.map((c: any) => c.text || '').join('')
  } else if (msg.parsed) {
    parsed = msg.parsed
  }

  try {
    parsed = JSON.parse(content)
  } catch {}
  return {
    ok: res.ok,
    status: res.status,
    durationMs,
    content,
    parsed,
    rawHead: txt.slice(0, 240),
    rawTail: txt.slice(-240),
    finishReason: finish,
    usage: json?.usage || null,
  }
}

/* ------------- Param router ------------- */
function applyCap(body: any, cap: number) {
  if (IS_GPT5) body.max_completion_tokens = cap
  else body.max_tokens = cap
}
function maybeTemperature(body: any) {
  if (!IS_GPT5 && Number.isFinite(TEMPERATURE)) body.temperature = TEMPERATURE
}

/* ------------- Schema & Tools ------------- */
const ALIGNMENT_SCHEMA = {
  name: 'alignment_assessment',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['insights', 'confidence'],
    properties: {
      insights: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 5,
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  },
}

const TOOL_DEF = [
  {
    type: 'function',
    function: {
      name: 'set_assessment',
      description: 'Return the alignment assessment JSON.',
      parameters: ALIGNMENT_SCHEMA.schema,
    },
  },
]

/* ---------------- Main ---------------- */
export async function POST(req: NextRequest) {
  const startTime = Date.now()
  console.log(`[Alignment] Request started at ${new Date().toISOString()}`)

  try {
    const body = await req.json().catch(() => ({}))
    const query = String(body?.query || '').trim()
    const resultsSummary = String(body?.resultsSummary || '').trim()

    console.log(
      `[Alignment] Processing: query=${query.slice(0, 50)}..., resultsSummary=${resultsSummary.slice(0, 50)}...`,
    )

    if (!query)
      return NextResponse.json(
        { ok: false, error: 'Missing query' },
        { status: 400 },
      )

    const apiKey = process.env.OPENAI_API_KEY?.trim()
    if (!apiKey) {
      const fallbackInsights: string[] = []

<<<<<<< HEAD
=======
      // Add doc snippets if available
      const docSnippets = docs
        .slice(0, 2)
        .map((d: Doc) => {
          const t = titleFrom(d)
          const s = firstSentence(snipFrom(d), 100)
          return s ? `${t}: ${s}` : t
        })
        .filter(Boolean)

      if (docSnippets.length > 0) {
        fallbackInsights.push(docSnippets.join('; '))
      } else {
        fallbackInsights.push('No sources provided.')
      }

>>>>>>> fe880d6 (update fallback logic for new structure)
      fallbackInsights.push('No API key set; offline heuristic.')
      fallbackInsights.push(
        'Set OPENAI_API_KEY and retry for full alignment analysis.',
      )

      return NextResponse.json({
        ok: true,
        assessment: {
          insights: fallbackInsights,
          confidence: 0.4,
        },
        debug: { fallback: true, reason: 'missing_api_key', model: MODEL },
      })
    }

    // Build compact prompt using your EXACT system prompt from config
    const sys = String(ALIGNMENT_SYSTEM_PROMPT || '') // DO NOT modify your prompt
    const userStr = resultsSummary

    const approxToks = estimateTokens(sys.length, userStr.length)
    // Increase timeouts for GPT-5 models which are slower
    const TIMEOUT_MAIN_MS = IS_GPT5
      ? Math.min(60000, BASE_MAIN_MS * 2 + approxToks * 15)
      : Math.min(35000, BASE_MAIN_MS + approxToks * 12)
    const TIMEOUT_REPAIR_MS = IS_GPT5
      ? Math.min(50000, BASE_REPAIR_MS * 2 + approxToks * 12)
      : Math.min(30000, BASE_REPAIR_MS + approxToks * 10)

    console.log(
      `[Alignment] Config: model=${MODEL}, tokens=${approxToks}, main_timeout=${TIMEOUT_MAIN_MS}ms, repair_timeout=${TIMEOUT_REPAIR_MS}ms`,
    )

    const tries: TryInfo[] = []

    /* ---- Variant 1: JSON SCHEMA ---- */
    const bodySchema: any = {
      model: MODEL,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userStr },
      ],
      response_format: { type: 'json_schema', json_schema: ALIGNMENT_SCHEMA },
    }
    applyCap(bodySchema, MAIN_MAX)
    maybeTemperature(bodySchema)
    let t
    try {
      t = await chatOnce(apiKey, bodySchema, TIMEOUT_MAIN_MS, 'json_schema')
    } catch (err: any) {
      console.log(`[Alignment] json_schema variant failed:`, err.message)
      tries.push({
        label: 'main',
        variant: 'json_schema',
        status: 0,
        durationMs: 0,
        finishReason: `error: ${err.message}`,
      })
      t = { ok: false, status: 0, parsed: null, durationMs: 0 }
    }
    tries.push({
      label: 'main',
      variant: 'json_schema',
      status: t.status,
      durationMs: t.durationMs,
      finishReason: t.finishReason,
      usage: t.usage,
      rawHead: t.rawHead,
      rawTail: t.rawTail,
    })

    if (t.ok && t.parsed && typeof t.parsed === 'object') {
      const sanitized = sanitizeAssessment(t.parsed as Assessment)
      return NextResponse.json({
        ok: true,
        assessment: sanitized,
        debug: { fallback: false, used: 'json_schema', model: MODEL, tries },
      })
    }

    // If rf unsupported or parsing failed, try Tools
    const needTools =
      t.status >= 400 &&
      /response[_ ]?format|unknown parameter/i.test(
        (t.rawHead || '') + (t.rawTail || ''),
      )

    /* ---- Variant 2: Tools (function call) ---- */
    if (needTools || !t.ok || !t.parsed) {
      const bodyTools: any = {
        model: MODEL,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userStr },
        ],
        tools: TOOL_DEF,
        tool_choice: { type: 'function', function: { name: 'set_assessment' } },
      }
      applyCap(bodyTools, MAIN_MAX)
      maybeTemperature(bodyTools)
      try {
        t = await chatOnce(apiKey, bodyTools, TIMEOUT_MAIN_MS, 'tools')
      } catch (err: any) {
        console.log(`[Alignment] tools variant failed:`, err.message)
        tries.push({
          label: 'main',
          variant: 'tools',
          status: 0,
          durationMs: 0,
          finishReason: `error: ${err.message}`,
        })
        t = { ok: false, status: 0, parsed: null, durationMs: 0 }
      }
      tries.push({
        label: 'main',
        variant: 'tools',
        status: t.status,
        durationMs: t.durationMs,
        finishReason: t.finishReason,
        usage: t.usage,
        rawHead: t.rawHead,
        rawTail: t.rawTail,
      })
      if (t.ok && t.parsed && typeof t.parsed === 'object') {
        const sanitized = sanitizeAssessment(t.parsed as Assessment)
        return NextResponse.json({
          ok: true,
          assessment: sanitized,
          debug: { fallback: false, used: 'tools', model: MODEL, tries },
        })
      }
    }

    /* ---- Variant 3: JSON OBJECT ---- */
    const bodyObject: any = {
      model: MODEL,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userStr },
      ],
      response_format: { type: 'json_object' },
    }
    applyCap(bodyObject, REPAIR_MAX)
    maybeTemperature(bodyObject)
    try {
      t = await chatOnce(apiKey, bodyObject, TIMEOUT_REPAIR_MS, 'json_object')
    } catch (err: any) {
      console.log(`[Alignment] json_object variant failed:`, err.message)
      tries.push({
        label: 'repair',
        variant: 'json_object',
        status: 0,
        durationMs: 0,
        finishReason: `error: ${err.message}`,
      })
      t = { ok: false, status: 0, parsed: null, durationMs: 0 }
    }
    tries.push({
      label: 'repair',
      variant: 'json_object',
      status: t.status,
      durationMs: t.durationMs,
      finishReason: t.finishReason,
      usage: t.usage,
      rawHead: t.rawHead,
      rawTail: t.rawTail,
    })
    if (t.ok && t.parsed && typeof t.parsed === 'object') {
      const sanitized = sanitizeAssessment(t.parsed as Assessment)
      return NextResponse.json({
        ok: true,
        assessment: sanitized,
        debug: { fallback: false, used: 'json_object', model: MODEL, tries },
      })
    }

    /* ---- Deterministic fallback ---- */
    const fallbackInsights: string[] = []

    fallbackInsights.push(
      'Unable to complete alignment assessment due to server error.',
    )
    fallbackInsights.push(
      'Try reducing prompt size, checking API quota, or retrying.',
    )

    const fallbackAssessment: Assessment = {
      insights: fallbackInsights,
      confidence: 0.5,
    }
    return NextResponse.json({
      ok: true,
      assessment: fallbackAssessment,
      debug: {
        fallback: true,
        reason: t.ok ? 'empty_or_unparseable_content' : `http_${t.status}`,
        model: MODEL,
        tries,
      },
    })
  } catch (err: any) {
    console.error(`[Alignment] Fatal error:`, err)
    const isTimeout = String(err?.message || err).includes('abort')
    const fallbackInsights = isTimeout
      ? [
          'Request timed out while processing alignment assessment.',
          'Try a shorter query or reduce document count.',
        ]
      : [
          'Exception occurred in alignment route.',
          'Unexpected server error. Please retry.',
        ]

    return NextResponse.json({
      ok: true,
      assessment: {
        insights: fallbackInsights,
        confidence: 0.5,
      },
      debug: {
        fallback: true,
        reason: String(err?.message || err),
        model: MODEL,
        isTimeout,
      },
    })
  }
}

export async function GET(req: NextRequest) {
  return NextResponse.json({
    ok: true,
    info: 'Alignment route v12.1 (model-aware params; json_schema→tools→json_object; compact; meta-sanitized; rich debug).',
    model: MODEL,
    hasKey: !!process.env.OPENAI_API_KEY,
  })
}
