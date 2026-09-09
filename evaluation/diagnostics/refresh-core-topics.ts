/**
 * Refresh evaluation/extractions/core-topics.json — the committed extraction
 * corpus for the abstention workbench.
 *
 * For every eval case in every evalset, takes N samples of the sidecar's
 * core_topic extraction using the SAME model, prompt and temperature as the
 * service (gpt-5.4-mini, temperature 0 — search-service/app/understanding_llm.py).
 * N > 1 makes the per-case flakiness VISIBLE: the extraction is a per-deploy
 * lottery (issue #402 — d9 was observed as both 'vertical farming' and the
 * full clause 'urban vertical farming or rooftop agriculture in cities'),
 * so a single sample is an anecdote, not a fact.
 *
 * This is an operator tool, not CI: it needs OPENAI_API_KEY (from the
 * environment, or search-service/.env as a local fallback). The committed
 * JSON is the shared artifact.
 *
 * Usage:
 *   npx tsx evaluation/diagnostics/refresh-core-topics.ts [--samples 3]
 */
import * as fs from 'fs'
import * as path from 'path'

const MODEL = 'gpt-5.4-mini' // must match settings.query_understanding_llm_model (search-service/app/config.py)
const OUT = path.join(__dirname, '..', 'extractions', 'core-topics.json')
const EVALSET_DIR = path.join(__dirname, '..', 'eval-review', 'evalsets')

// MUST stay identical to _SYSTEM in search-service/app/understanding_llm.py.
const SYSTEM =
  "You analyze a search query for a document retrieval system over WRI's " +
  'published corpus. Return JSON with: intent (one of "topical", ' +
  '"known_item", "catalog", "binary_presence"), facets (a list of ' +
  '{facet, value, confidence} where facet is one of "year_min", ' +
  '"year_max", "language", "program", "excluded_keyword" and ' +
  'confidence is 0.0-1.0), variants (0-2 alternative phrasings of the query), ' +
  'disambiguation (alternative readings if the query is ambiguous, else ' +
  "empty), and core_topic (the single core noun phrase of the query's " +
  "SUBJECT only - not the framing. Strip generic framing like 'WRI " +
  "publications', 'has WRI written about', 'research on', 'published on' " +
  '- the core_topic is the specific subject the query is about (e.g. for ' +
  "'What has WRI published authored by Pawan Mulukutla' -> 'Pawan Mulukutla'; " +
  "'surveillance technologies' -> 'surveillance technologies'; 'vertical " +
  "farming' -> 'vertical farming'; 'hydrogen' -> 'hydrogen'; 'container " +
  "port decarbonization' -> 'container port decarbonization'). Used for a " +
  'corpus-coverage abstain check). Return only JSON, no commentary.'

function loadKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY
  const envPath = path.join(__dirname, '..', '..', 'search-service', '.env')
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      if (line.startsWith('OPENAI_API_KEY=')) {
        return line
          .slice('OPENAI_API_KEY='.length)
          .trim()
          .replace(/^["']|["']$/g, '')
      }
    }
  }
  throw new Error('OPENAI_API_KEY not set (env or search-service/.env)')
}

async function extractCoreTopic(
  key: string,
  query: string,
): Promise<string | null> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: query },
      ],
      max_completion_tokens: 600,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`OpenAI → ${res.status}`)
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) return null
  const parsed = JSON.parse(content)
  const core = parsed.core_topic
  return typeof core === 'string' && core.trim() ? core : null
}

function modal(samples: (string | null)[]): string | null {
  const counts = new Map<string, number>()
  for (const s of samples) if (s) counts.set(s, (counts.get(s) ?? 0) + 1)
  let best: string | null = null
  let bestN = 0
  for (const [s, n] of counts) {
    if (n > bestN) {
      best = s
      bestN = n
    }
  }
  return best
}

async function main() {
  const args = process.argv.slice(2)
  const samplesIdx = args.indexOf('--samples')
  const N = samplesIdx >= 0 ? Number(args[samplesIdx + 1]) || 3 : 3
  const key = loadKey()

  const sets = fs
    .readdirSync(EVALSET_DIR)
    .filter((f) => f.endsWith('.json') && !f.includes('_bkup'))
    .sort()

  const cases: Record<
    string,
    {
      question: string
      polarity: string
      samples: (string | null)[]
      modal: string | null
    }
  > = {}
  let total = 0
  for (const set of sets) {
    const evalset = JSON.parse(
      fs.readFileSync(path.join(EVALSET_DIR, set), 'utf-8'),
    )
    for (const tc of evalset.test_cases ?? []) {
      const expected =
        tc.expected_external_ids ??
        tc.retrieval_ground_truth?.expected_external_ids ??
        []
      const samples: (string | null)[] = []
      for (let i = 0; i < N; i++) {
        samples.push(await extractCoreTopic(key, tc.question))
      }
      cases[tc.id] = {
        question: tc.question,
        polarity: expected.length === 0 ? 'negative' : 'positive',
        samples,
        modal: modal(samples),
      }
      total++
      process.stdout.write(
        `  ${tc.id.padEnd(45)} ${samples[0] === null ? 'NULL' : 'ok'}\r`,
      )
    }
  }

  const out = {
    updated: new Date().toISOString(),
    model: MODEL,
    samples_per_case: N,
    note: 'core_topic extraction samples per eval case, same model/prompt/temperature as the service sidecar. modal is the majority sample; disagreeing samples mark the per-deploy extraction lottery (#402).',
    cases,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1))

  const flaky = Object.entries(cases).filter(
    ([, c]) => new Set(c.samples).size > 1,
  )
  console.log(`\nExtractions: ${OUT}`)
  console.log(
    `  ${total} cases x ${N} samples | flaky (disagreeing samples): ${flaky.length}`,
  )
  for (const [id, c] of flaky) {
    console.log(`  ! ${id}: ${JSON.stringify(c.samples)}`)
  }
}

main().catch((error) => {
  console.error(`FATAL: ${error.message}`)
  process.exit(1)
})
