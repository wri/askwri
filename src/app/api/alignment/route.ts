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
} from '@/config/alignment'
import { resolveAlignmentConfig } from '@/lib/alignment-config'
import { isEnglishText } from '@/lib/ensure-english'
import { requestProfile, wireParams } from '@/lib/request-profile'
import { resolveRouteModel, type RouteProvenance } from '@/lib/route-model'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/* ---------------- Config ---------------- */
// Read at import: this is the route's own default, used whenever the request
// names no model. A requested model is resolved per request in POST, and every
// model-derived parameter below is computed from that resolved name.
const FALLBACK_MODEL = (
  process.env.OPENAI_MODEL_ALIGNMENT ??
  process.env.OPENAI_MODEL ??
  CFG_MODEL ??
  'gpt-5-mini'
).trim()
const BASE_URL = (
  process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
).replace(/\/$/, '')

// This route answers 200 with a canned assessment on every failure, so
// `produced: false` is what keeps a response no model authored from reading as
// evidence; `fallback_reason` names the cause. `sanitized` is added only by the
// returns where the sanitizer rewrote an answer the model did give.
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

function producedProvenance(
  model: string,
  sanitized: boolean,
): RouteProvenance {
  return sanitized
    ? { model, produced: true, sanitized: true }
    : { model, produced: true }
}

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
  alignment: 'High' | 'Moderate' | 'Low' | 'Very Low'
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

// Build metaSet once at module level for efficiency
const META_SET = new Set(META_PHRASES.map((s) => s.trim().toLowerCase()))

function stripMeta(arr: string[], limit: number): string[] {
  const cleaned = (arr || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .filter((s) => !META_SET.has(s.toLowerCase()))
  // Return up to 'limit' items, don't truncate the text
  return cleaned.slice(0, limit)
}

// `sanitized` is true when the response carries text the model did not write:
// the canned insight replacing an empty/non-English set, or `Moderate` replacing
// an alignment value outside the enum. The model still answered, so the caller
// keeps `produced: true`.
function sanitizeAssessment(input: any = {}): {
  assessment: Assessment
  sanitized: boolean
} {
  const insightsRaw = Array.isArray(input?.insights) ? input.insights : []
  // Issue #386: drop insights that mirrored a non-English query/passage —
  // prompt pins alone already failed once on QA. Empty result falls through
  // to the English fallback below.
  const insights = stripMeta(insightsRaw, 5).filter(isEnglishText)
  const alignmentRaw =
    typeof input.alignment === 'string' ? input.alignment.trim() : ''

  const validAlignments = ['High', 'Moderate', 'Low', 'Very Low']
  const insightsSubstituted = insights.length === 0
  const alignmentCoerced = !validAlignments.includes(alignmentRaw)

  if (insightsSubstituted || alignmentCoerced) {
    console.warn(
      '[Alignment] Sanitization fallback triggered. Raw input:',
      input,
      insights,
      alignmentRaw,
    )
  }

  const assessment: Assessment = {
    insights: insightsSubstituted
      ? [
          'Unable to assess alignment. Try providing more sources or refining your query.',
        ]
      : insights,
    alignment: alignmentCoerced
      ? 'Moderate'
      : (alignmentRaw as Assessment['alignment']),
  }

  return { assessment, sanitized: insightsSubstituted || alignmentCoerced }
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
// Which parameters a model accepts depends on the model actually being
// asked, not on the route's default: the token cap and the temperature come
// from requestProfile as the exact wire fields, spread where today's
// mutators inserted them so the body's key order is unchanged.

/* ------------- Schema & Tools ------------- */
const ALIGNMENT_SCHEMA = {
  name: 'alignment_assessment',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['insights', 'alignment'],
    properties: {
      insights: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 5,
      },
      alignment: {
        type: 'string',
        enum: ['High', 'Moderate', 'Low', 'Very Low'],
      },
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

  // The model this response is about, for the catch-all below that cannot re-read
  // the request body.
  let model = FALLBACK_MODEL

  try {
    const body = await req.json().catch(() => ({}))
    const query = String(body?.query || '').trim()
    const resultsSummary = String(body?.resultsSummary || '').trim()

    console.log(
      `[Alignment] Processing: query=${query.slice(0, 50)}..., resultsSummary=${resultsSummary.slice(0, 50)}...`,
    )

    // Resolved before any other check, and refused rather than ignored: a sweep
    // that thinks it ran two models must not run one twice.
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
    const cfg = resolveAlignmentConfig(model)
    const primary = requestProfile({
      task: 'alignment',
      model,
      attempt: 'primary',
      input: {},
    })
    const repair = requestProfile({
      task: 'alignment',
      model,
      attempt: 'repair',
      input: {},
    })

    if (!query)
      return NextResponse.json(
        {
          ok: false,
          error: 'Missing query',
          provenance: provenance(cfg.model, false, 'no_text'),
        },
        { status: 400 },
      )

    const apiKey = process.env.OPENAI_API_KEY?.trim()
    if (!apiKey) {
      const fallbackInsights: string[] = []

      fallbackInsights.push('No API key set; offline heuristic.')
      fallbackInsights.push(
        'Set OPENAI_API_KEY and retry for full alignment analysis.',
      )

      return NextResponse.json({
        ok: true,
        assessment: {
          insights: fallbackInsights,
          alignment: 'Low',
        },
        debug: { fallback: true, reason: 'missing_api_key', model: cfg.model },
        provenance: provenance(cfg.model, false, 'no_api_key'),
      })
    }

    // Build compact prompt using your EXACT system prompt from config
    const sys = String(ALIGNMENT_SYSTEM_PROMPT || '') // DO NOT modify your prompt
    const userStr = resultsSummary

    const approxToks = estimateTokens(sys.length, userStr.length)
    // Increase timeouts for GPT-5 models which are slower: the bases are
    // scaled per request and clamped here, in the route.
    const TIMEOUT_MAIN_MS = cfg.gpt5Class
      ? Math.min(60000, cfg.mainMs * 2 + approxToks * 15)
      : Math.min(35000, cfg.mainMs + approxToks * 12)
    const TIMEOUT_REPAIR_MS = cfg.gpt5Class
      ? Math.min(50000, cfg.repairMs * 2 + approxToks * 12)
      : Math.min(30000, cfg.repairMs + approxToks * 10)

    console.log(
      `[Alignment] Config: model=${cfg.model}, tokens=${approxToks}, main_timeout=${TIMEOUT_MAIN_MS}ms, repair_timeout=${TIMEOUT_REPAIR_MS}ms`,
    )

    const tries: TryInfo[] = []

    /* ---- Variant 1: JSON SCHEMA ---- */
    const bodySchema: any = {
      model: cfg.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userStr },
      ],
      response_format: { type: 'json_schema', json_schema: ALIGNMENT_SCHEMA },
      ...wireParams(primary),
    }
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
      usage: t.usage ? { ...t.usage, model: `openai/${cfg.model}` } : null,
      rawHead: t.rawHead,
      rawTail: t.rawTail,
    })

    if (t.ok && t.parsed && typeof t.parsed === 'object') {
      const { assessment, sanitized } = sanitizeAssessment(
        t.parsed as Assessment,
      )
      return NextResponse.json({
        ok: true,
        assessment,
        debug: {
          fallback: false,
          used: 'json_schema',
          model: cfg.model,
          tries,
        },
        provenance: producedProvenance(cfg.model, sanitized),
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
        model: cfg.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userStr },
        ],
        tools: TOOL_DEF,
        tool_choice: { type: 'function', function: { name: 'set_assessment' } },
        ...wireParams(primary),
      }
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
        usage: t.usage ? { ...t.usage, model: `openai/${cfg.model}` } : null,
        rawHead: t.rawHead,
        rawTail: t.rawTail,
      })
      if (t.ok && t.parsed && typeof t.parsed === 'object') {
        const { assessment, sanitized } = sanitizeAssessment(
          t.parsed as Assessment,
        )
        return NextResponse.json({
          ok: true,
          assessment,
          debug: { fallback: false, used: 'tools', model: cfg.model, tries },
          provenance: producedProvenance(cfg.model, sanitized),
        })
      }
    }

    /* ---- Variant 3: JSON OBJECT ---- */
    const bodyObject: any = {
      model: cfg.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userStr },
      ],
      response_format: { type: 'json_object' },
      ...wireParams(repair),
    }
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
      usage: t.usage ? { ...t.usage, model: `openai/${cfg.model}` } : null,
      rawHead: t.rawHead,
      rawTail: t.rawTail,
    })
    if (t.ok && t.parsed && typeof t.parsed === 'object') {
      const { assessment, sanitized } = sanitizeAssessment(
        t.parsed as Assessment,
      )
      return NextResponse.json({
        ok: true,
        assessment,
        debug: {
          fallback: false,
          used: 'json_object',
          model: cfg.model,
          tries,
        },
        provenance: producedProvenance(cfg.model, sanitized),
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
      alignment: 'Moderate',
    }
    return NextResponse.json({
      ok: true,
      assessment: fallbackAssessment,
      debug: {
        fallback: true,
        reason: t.ok ? 'empty_or_unparseable_content' : `http_${t.status}`,
        model: cfg.model,
        tries,
      },
      // status 0 means no response was ever read (a thrown request or an abort),
      // so `upstream_0` would name a status no provider returned.
      provenance: provenance(
        cfg.model,
        false,
        t.ok ? 'parse_error' : t.status > 0 ? `upstream_${t.status}` : 'error',
      ),
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
        alignment: 'Moderate',
      },
      debug: {
        fallback: true,
        reason: String(err?.message || err),
        model,
        isTimeout,
      },
      provenance: provenance(model, false, 'error'),
    })
  }
}

export async function GET(req: NextRequest) {
  return NextResponse.json({
    ok: true,
    info: 'Alignment route v12.1 (model-aware params; json_schema→tools→json_object; compact; meta-sanitized; rich debug).',
    model: FALLBACK_MODEL,
    hasKey: !!process.env.OPENAI_API_KEY,
  })
}
