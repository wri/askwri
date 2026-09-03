/**
 * Shared control parsing for the answer-eval stage CLIs (§3.5). One parser,
 * four stages — judge/score/compare reuse the same flags when they land.
 *
 * Knob routing is the safety rail: only the six synthesis knobs reach
 * /api/answer; everything else must be a forwardable /query field. The
 * forwardable list is imported from the SHIPPED gateway route so it can never
 * drift from the code that enforces it (verified 2026-09-05: the tsx import
 * of the route module resolves fine, so the plan's ruling-5 fallback —
 * git blob SHA + hard-fail — is not wired; if the import ever breaks, delete
 * nothing silently: fail loudly and record the route file's blob SHA in
 * provenance instead). An unknown knob is a hard error at parse time — a
 * typo must never silently change what a capture measured.
 */
import * as path from 'path'
import { FORWARDABLE_FIELDS } from '@/app/api/llamaindex/route'

export interface Controls {
  only: string[]
  limit?: number
  passes: number
  label: string
  concurrency: number
  targetUrl: string
  directSearchUrl?: string
  directAnswerUrl?: string
  retrievalKnobs: Record<string, unknown>
  synthesisKnobs: Record<string, unknown>
  judgeModel?: string
  judgeBaseUrl?: string
  evalsetPath: string
}

const SYNTHESIS_KNOB_KEYS = new Set([
  'model',
  'base_url',
  'max_passages',
  'passage_chars',
  'prompt_version',
  'likely_off_topic',
])

const USAGE = `usage: <evalset.json> [--only id]... [--limit N] [--passes N] [--label name]
       [--concurrency N] [--target URL] [--knob key=value]...
       [--direct-search URL --direct-answer URL]
       [--judge-model M] [--judge-base-url URL]
synthesis knobs: ${[...SYNTHESIS_KNOB_KEYS].join(', ')}
retrieval knobs: any forwardable /query field (FORWARDABLE_FIELDS in
                 src/app/api/llamaindex/route.ts)`

function fail(msg: string): never {
  throw new Error(`cli: ${msg}\n${USAGE}`)
}

/** '0.8' → 0.8, 'true' → true, anything else stays a string. */
function coerceValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function intFlag(name: string, raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    fail(`--${name} expects a positive integer, got: ${raw}`)
  }
  return n
}

export function parseControls(
  argv: string[],
  stage: 'capture' | 'judge' | 'score' | 'compare',
): Controls {
  // Normalize `--flag=value` into `--flag value` so one loop handles both.
  const args: string[] = []
  for (const a of argv) {
    if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=')
      args.push(a.slice(0, eq), a.slice(eq + 1))
    } else {
      args.push(a)
    }
  }

  let evalsetPath: string | undefined
  const only: string[] = []
  const knobs: Array<[string, unknown]> = []
  const ctl: Controls = {
    only,
    limit: undefined,
    passes: 1,
    label: '',
    concurrency: 1,
    targetUrl: process.env.EVAL_TARGET || 'https://qa.askwri-app.org',
    directSearchUrl: undefined,
    directAnswerUrl: undefined,
    retrievalKnobs: {},
    synthesisKnobs: {},
    judgeModel: 'glm-5.2-vision',
    judgeBaseUrl: process.env.LUNAROUTE_BASE_URL,
    evalsetPath: '',
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) {
      if (evalsetPath)
        fail(`unexpected argument: ${a} (input path already ${evalsetPath})`)
      evalsetPath = a
      continue
    }
    const flag = a.slice(2)
    const value = (): string => {
      const v = args[++i]
      if (v === undefined || v.startsWith('--')) {
        fail(`--${flag} requires a value`)
      }
      return v
    }
    switch (flag) {
      case 'only':
        only.push(value())
        break
      case 'limit':
        ctl.limit = intFlag('limit', value())
        break
      case 'passes':
        ctl.passes = intFlag('passes', value())
        break
      case 'label':
        ctl.label = value()
        break
      case 'concurrency':
        ctl.concurrency = intFlag('concurrency', value())
        break
      case 'target':
        ctl.targetUrl = value()
        break
      case 'knob': {
        const kv = value()
        const eq = kv.indexOf('=')
        if (eq === -1) fail(`--knob expects key=value, got: ${kv}`)
        knobs.push([kv.slice(0, eq), coerceValue(kv.slice(eq + 1))])
        break
      }
      case 'direct-search':
        ctl.directSearchUrl = value()
        break
      case 'direct-answer':
        ctl.directAnswerUrl = value()
        break
      case 'judge-model':
        ctl.judgeModel = value()
        break
      case 'judge-base-url':
        ctl.judgeBaseUrl = value()
        break
      default:
        fail(`unknown flag --${flag} (stage: ${stage})`)
    }
  }

  if (!evalsetPath) fail(`missing <evalset> path (stage: ${stage})`)
  ctl.evalsetPath = evalsetPath
  ctl.label = ctl.label || path.parse(evalsetPath).name

  for (const [key, v] of knobs) {
    if (SYNTHESIS_KNOB_KEYS.has(key)) {
      ctl.synthesisKnobs[key] = v
    } else if (FORWARDABLE_FIELDS.has(key)) {
      ctl.retrievalKnobs[key] = v
    } else {
      fail(
        `unknown knob: ${key} — synthesis knobs are ` +
          `${[...SYNTHESIS_KNOB_KEYS].join(', ')}; retrieval knobs must be ` +
          `forwardable /query fields (FORWARDABLE_FIELDS in ` +
          `src/app/api/llamaindex/route.ts)`,
      )
    }
  }

  if (ctl.directSearchUrl && !ctl.directAnswerUrl) {
    fail(
      '--direct-search requires --direct-answer (the app serving /api/answer)',
    )
  }
  if (ctl.directAnswerUrl && !ctl.directSearchUrl) {
    fail(
      '--direct-answer requires --direct-search (without it the run silently falls back to gateway mode)',
    )
  }
  return ctl
}
