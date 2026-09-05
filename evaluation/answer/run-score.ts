/**
 * Score CLI: reduce a stored capture + judged artifact into the report.
 * Usage:
 *
 *   npm run eval:answer-score -- --capture artifacts/capture-X.json
 *                              --judged artifacts/judged-X.json [--label name]
 *                              [--labels <file-or-dir>]...  (§4.5 judge calibration)
 *
 * The evalset is re-loaded from the capture's recorded fixture path (twin
 * pairs live only there). The report lands in
 * evaluation/answer/artifacts/report-<label>.json (label parsed from the
 * capture filename by default). Pure reduction — the report carries no
 * timestamp of its own, so re-running over the same inputs writes
 * byte-identical bytes.
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  HumanLabels,
  JudgeAgreement,
  VerdictTally,
  labelRejections,
  loadLabelsFrom,
} from './labels'
import { loadEvalset } from './fixture'
import { BlockReport, MetricMean, score, writeReportArtifact } from './score'
import { CaptureArtifact } from './types'

const USAGE = `usage: run-score --capture <capture-X.json> --judged <judged-X.json>
                 [--label name] [--labels <labels-file-or-dir>]...`

function fail(msg: string): never {
  console.error(`run-score: ${msg}\n${USAGE}`)
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
  let capturePath: string | undefined
  let judgedPath: string | undefined
  let label: string | undefined
  const labels: string[] = []
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
      case 'judged':
        judgedPath = value()
        break
      case 'label':
        label = value()
        break
      case 'labels':
        labels.push(value())
        break
      default:
        fail(`unknown flag --${flag}`)
    }
  }
  if (!capturePath) fail('missing --capture <path>')
  if (!judgedPath) fail('missing --judged <path>')
  if (!label) {
    const base = path.basename(capturePath)
    label =
      base.match(/^capture-(.+)\.json$/)?.[1] ?? path.parse(capturePath).name
  }
  return { capturePath, judgedPath, label, labels }
}

const fmtMean = (m: MetricMean): string =>
  m.mean === null ? 'n/a' : m.mean.toFixed(3)

/** `agree/either (p%)` — `n/a` when the symmetric denominator is 0. */
const fmtTally = (t: VerdictTally, verdict: string): string => {
  const agree = t.agree[verdict] ?? 0
  const either = t.either[verdict] ?? 0
  const pct = either > 0 ? ((agree / either) * 100).toFixed(1) : 'n/a'
  return `${agree}/${either} (${pct}%)`
}

/** §4.5 judge-calibration lines, printed only when labels were supplied. */
function printJudgeAgreement(ag: JudgeAgreement): void {
  console.log(
    `[score] judge: calibrated against ${ag.labels} label file(s) ` +
      `by reviewer(s): ${ag.reviewers.join(', ')}`,
  )
  const f = ag.fact_recall
  const s = ag.sentence_support
  const uc = ag.unsupported_claims
  const ucPct =
    uc.compared > 0 ? ((uc.agree / uc.compared) * 100).toFixed(1) : 'n/a'
  console.log(
    `[score] judge-vs-human: ` +
      `fact stated ${fmtTally(f.stated, 'stated')}, ` +
      `partial ${fmtTally(f.partial, 'partial')}, ` +
      `absent ${fmtTally(f.absent, 'absent')}; ` +
      `sentence supported ${fmtTally(s.supported, 'supported')}, ` +
      `unsupported ${fmtTally(s.unsupported, 'unsupported')}; ` +
      `unsupported_claims ${uc.agree}/${uc.compared} (${ucPct}%)`,
  )
}

/** Load --labels paths (files or dirs) and validate every label against the
 * capture — exit 2 listing every rejection (identified by the labels'
 * self-declared `capture_file`, which is identical across a capture's label
 * set) + reason, never skip. */
function loadAndValidateLabels(
  paths: string[],
  capturePath: string,
  capture: CaptureArtifact,
): HumanLabels[] | undefined {
  if (paths.length === 0) return undefined
  const labels = loadLabelsFrom(paths)
  if (labels.length === 0) {
    fail(`no label files found under: ${paths.join(', ')}`)
  }
  const rejected = labelRejections(labels, capture)
  if (rejected.length > 0) {
    fail(
      `${rejected.length} of ${labels.length} label file(s) do not match capture ${capturePath} — ${rejected.join('; ')}`,
    )
  }
  return labels
}

function printBlock(name: string, b: BlockReport): void {
  console.log(`${name} — ${b.cases} case(s):`)
  const r = b.retrieval
  console.log(
    `  retrieval: evidence_coverage=${fmtMean(r.evidence_coverage)} ` +
      `doc_map=${fmtMean(r.doc_map)} attainable_recall=${fmtMean(r.attainable_recall)} ` +
      `distinct_docs=${fmtMean(r.distinct_docs)} top_doc_share=${fmtMean(r.top_doc_share)} ` +
      `chunk_id_hit_rate=${fmtMean(r.chunk_id_hit_rate)}`,
  )
  const s = b.synthesis
  console.log(
    `  synthesis: fact_recall_strict=${fmtMean(s.fact_recall_strict)} ` +
      `fact_recall_lenient=${fmtMean(s.fact_recall_lenient)} ` +
      `citation_precision=${fmtMean(s.citation_precision)} ` +
      `unsupported_claims=${s.unsupported_claims_count} over ${s.unsupported_claims_judged_passes} judged pass(es) ` +
      `unsupported_rate=${fmtMean(s.unsupported_claims_rate)}`,
  )
  const c = b.compliance
  console.log(
    `  compliance: cites_valid=${c.cites_valid}/${c.passes} ` +
      `parsed_clean=${c.parsed_clean}/${c.passes} ` +
      `all_english=${c.all_english}/${c.passes}`,
  )
  if (b.abstention.negative_cases > 0) {
    console.log(
      `  abstention (negative cases): ${b.abstention.abstained}/${b.abstention.passes} ` +
        `pass(s) abstained (rate ${b.abstention.rate.toFixed(3)})`,
    )
  }
}

function main(): void {
  const a = parseArgs(process.argv.slice(2))
  const capture = JSON.parse(fs.readFileSync(a.capturePath, 'utf8'))
  const judged = JSON.parse(fs.readFileSync(a.judgedPath, 'utf8'))
  const evalset = loadEvalset(capture.provenance.fixture.path)
  const labels = loadAndValidateLabels(a.labels, a.capturePath, capture)

  const report = score(evalset, capture, judged, labels)
  const file = writeReportArtifact(
    path.join(__dirname, 'artifacts'),
    a.label,
    report,
  )

  const header = report.header as Record<string, any>
  const agreement = header.judge_agreement as JudgeAgreement | undefined
  if (agreement) {
    printJudgeAgreement(agreement)
  } else {
    console.log('[score] judge: uncalibrated (no human labels yet)')
  }
  printBlock('headline', report.headline as unknown as BlockReport)
  printBlock('draft', report.draft_block as unknown as BlockReport)
  const h = header
  const u = h.unjudged
  console.log(
    `[score] unjudged: ${u.total} (fact_recall ${u.fact_recall}, ` +
      `sentence_support ${u.sentence_support}, unsupported_claims ${u.unsupported_claims})`,
  )
  const e = h.excluded_passes
  console.log(
    `[score] excluded passes: ${e.retrieval_error} retrieval error(s), ` +
      `${e.answer_error} answer error(s)`,
  )
  console.log(`\nwrote ${file}`)
}

main()
