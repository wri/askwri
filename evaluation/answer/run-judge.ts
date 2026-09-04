/**
 * Judge CLI: judge a stored capture. Usage:
 *
 *   npm run eval:answer-judge -- --capture artifacts/capture-X.json
 *
 * Writes `judged-<label>.json` next to the capture (label parsed from the
 * capture filename by default). Resumable — re-running skips items already
 * judged. The judge base URL defaults to $LUNAROUTE_BASE_URL and the API key
 * follows resolveProvider's rule (LUNAROUTE_API_KEY when the base URL matches
 * $LUNAROUTE_BASE_URL, else OPENAI_API_KEY). Exits 1 on judge 401 — the core
 * has already printed and persisted the partial artifact — and when every
 * item this run attempted came back unjudged (a misconfigured judge must not
 * look like a clean run with an empty report).
 */
import * as fs from 'fs'
import * as path from 'path'
import { runJudge } from './judge'
import { JudgeAuthError } from './judge-client'

const USAGE = `usage: run-judge --capture <capture-X.json> [--label name]
       [--judge-model M] [--judge-base-url URL] [--only id]... [--concurrency N]`

function fail(msg: string): never {
  console.error(`run-judge: ${msg}\n${USAGE}`)
  process.exit(2)
}

function intFlag(name: string, raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    fail(`--${name} expects a positive integer, got: ${raw}`)
  }
  return n
}

function parseArgs(argv: string[]) {
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
  let capturePath: string | undefined
  let label: string | undefined
  let judgeModel = 'glm-5.2-vision'
  let judgeBaseUrl = process.env.LUNAROUTE_BASE_URL ?? ''
  const only: string[] = []
  let concurrency = 1
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) fail(`unexpected argument: ${args[i]}`)
    const flag = args[i].slice(2)
    const value = (): string => {
      const v = args[++i]
      if (v === undefined || v.startsWith('--')) {
        fail(`--${flag} requires a value`)
      }
      return v
    }
    switch (flag) {
      case 'capture':
        capturePath = value()
        break
      case 'label':
        label = value()
        break
      case 'judge-model':
        judgeModel = value()
        break
      case 'judge-base-url':
        judgeBaseUrl = value()
        break
      case 'only':
        only.push(value())
        break
      case 'concurrency':
        concurrency = intFlag('concurrency', value())
        break
      default:
        fail(`unknown flag --${flag}`)
    }
  }
  if (!capturePath) fail('missing --capture <path>')
  if (!judgeBaseUrl) {
    fail('no judge base URL — set LUNAROUTE_BASE_URL or pass --judge-base-url')
  }
  if (!label) {
    const base = path.basename(capturePath)
    label =
      base.match(/^capture-(.+)\.json$/)?.[1] ?? path.parse(capturePath).name
  }
  return { capturePath, label, judgeModel, judgeBaseUrl, only, concurrency }
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2))
  const capture = JSON.parse(fs.readFileSync(a.capturePath, 'utf8'))
  const judgedPath = path.join(
    path.dirname(a.capturePath),
    `judged-${a.label}.json`,
  )
  let run
  try {
    run = await runJudge({
      capture,
      judgedPath,
      judgeModel: a.judgeModel,
      judgeBaseUrl: a.judgeBaseUrl,
      only: a.only,
      concurrency: a.concurrency,
    })
  } catch (e) {
    if (e instanceof JudgeAuthError) process.exit(1)
    throw e
  }
  console.log(`\nwrote ${judgedPath}`)
  if (run.judged === 0 && run.unjudged > 0) {
    console.error(
      `run-judge: every item came back unjudged (${Object.entries(run.reasons)
        .map(([k, v]) => `${k}×${v}`)
        .join(', ')}) — check --judge-model / --judge-base-url before scoring`,
    )
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
