/**
 * Compare CLI: three read-only views. Usage:
 *
 *   npm run eval:answer-compare -- <reportA.json> <reportB.json>
 *   npm run eval:answer-compare -- --judged <judgedA.json> <judgedB.json>
 *   npm run eval:answer-compare -- --pairwise <captureA.json> <captureB.json>
 *                                [--label-a X --label-b Y]
 *                                [--judge-model M] [--judge-base-url URL]
 *
 * Report/judged modes print to stdout. Pairwise mode writes
 * `pairwise-<labelA>-vs-<labelB>.json` next to capture A (resumable —
 * re-running skips (case,pass) pairs already judged) and prints the win-rate
 * report. The judge base URL defaults to $LUNAROUTE_BASE_URL and the API key
 * follows resolveProvider's rule (same as run-judge). Exits 1 on a guard
 * refusal or judge 401.
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  compareReports,
  judgedAgreement,
  pairwiseSummary,
  runPairwise,
} from './compare'
import { judgeCall, JudgeAuthError } from './judge-client'

const USAGE = `usage: run-compare <reportA.json> <reportB.json>
       run-compare --judged <judgedA.json> <judgedB.json>
       run-compare --pairwise <captureA.json> <captureB.json>
                   [--label-a X --label-b Y] [--judge-model M] [--judge-base-url URL]`

function fail(msg: string): never {
  console.error(`run-compare: ${msg}\n${USAGE}`)
  process.exit(2)
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
  let mode: 'reports' | 'judged' | 'pairwise' = 'reports'
  const positionals: string[] = []
  let labelA: string | undefined
  let labelB: string | undefined
  let judgeModel = 'glm-5.2-vision'
  let judgeBaseUrl = process.env.LUNAROUTE_BASE_URL ?? ''
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--judged' || a === '--pairwise') {
      mode = a.slice(2) as 'judged' | 'pairwise'
      continue
    }
    if (!a.startsWith('--')) {
      positionals.push(a)
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
      case 'label-a':
        labelA = value()
        break
      case 'label-b':
        labelB = value()
        break
      case 'judge-model':
        judgeModel = value()
        break
      case 'judge-base-url':
        judgeBaseUrl = value()
        break
      default:
        fail(`unknown flag --${flag}`)
    }
  }
  if (positionals.length !== 2) fail('expected exactly two input paths')
  if (mode === 'pairwise' && !judgeBaseUrl) {
    fail('no judge base URL — set LUNAROUTE_BASE_URL or pass --judge-base-url')
  }
  return {
    mode,
    pathA: positionals[0],
    pathB: positionals[1],
    labelA,
    labelB,
    judgeModel,
    judgeBaseUrl,
  }
}

const labelFromPath = (p: string): string =>
  path.basename(p).match(/^capture-(.+)\.json$/)?.[1] ?? path.parse(p).name

const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'))

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2))
  try {
    if (a.mode === 'reports') {
      console.log(compareReports(readJson(a.pathA), readJson(a.pathB)))
    } else if (a.mode === 'judged') {
      console.log(judgedAgreement(readJson(a.pathA), readJson(a.pathB)))
    } else {
      const labelA = a.labelA ?? labelFromPath(a.pathA)
      const labelB = a.labelB ?? labelFromPath(a.pathB)
      const pairwisePath = path.join(
        path.dirname(a.pathA),
        `pairwise-${labelA}-vs-${labelB}.json`,
      )
      const artifact = await runPairwise({
        captureA: readJson(a.pathA),
        captureB: readJson(a.pathB),
        labelA,
        labelB,
        pairwisePath,
        judge: judgeCall,
        judgeModel: a.judgeModel,
        judgeBaseUrl: a.judgeBaseUrl,
      })
      console.log(pairwiseSummary(artifact))
      console.log(`\nwrote ${pairwisePath}`)
    }
  } catch (e) {
    if (e instanceof JudgeAuthError) process.exit(1)
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
}

main()
