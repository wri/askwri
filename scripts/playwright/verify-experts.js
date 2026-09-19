/* Playwright walk of the RENDERED /experts surface.
 *
 * WHY THIS EXISTS, given a green Jest suite: `next/jest` stubs CSS imports, so
 * jsdom never computes style. A whole class of bug is therefore invisible to
 * unit tests by construction — a rule that does not apply, one that applies too
 * broadly, or an inline style outranking the stylesheet. Four real bugs shipped
 * green past the suite and were caught here:
 *
 *   - every list row rendered at 45% opacity at rest (the unit test asserted
 *     the data attribute, which was correct);
 *   - an inline `background:'none'` / `border:0` outranked the stylesheet, so
 *     the selected row's ink rule, its wash and the gold peer tint had NEVER
 *     rendered — while a guard test that read Experts.css as TEXT passed,
 *     because the rules were right and merely inert;
 *   - a person label was overdrawn by a neighbouring node (SVG paints in
 *     document order);
 *   - the selected person's ink name tab was sized from a character count and
 *     ran 5px short, dropping the final glyph into the white background.
 *
 * Each check has been verified to FAIL on the bug it claims to catch. A check
 * that cannot fail is decoration, not a gate.
 *
 * Scope: payload in, pixels out. It intercepts POST /api/experts with a fixture
 * and never touches the search service or the database, which makes it
 * deterministic, independent of AWS credentials, and runnable against a local
 * corpus that has zero tag_embeddings (and so cannot produce a healthy results
 * page at all). It is NOT a test of retrieval or ranking.
 *
 * Run:
 *   npm run dev -- -p 3100        # in another shell
 *   npx playwright install chromium   # first time only
 *   npm run verify:experts
 *
 * Exits non-zero if any check fails.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright')

const BASE = process.env.EXPERTS_BASE_URL || 'http://localhost:3100'
// Screenshots are evidence, not artifacts to commit: default them outside the
// repo. Point EXPERTS_SHOT_DIR somewhere durable when attaching them to a PR.
const OUT =
  process.env.EXPERTS_SHOT_DIR || path.join(os.tmpdir(), 'experts-walk')
fs.mkdirSync(OUT, { recursive: true })

const person = (key, name, office, score, topics, ev) => ({
  key,
  name,
  office,
  offices: { [office]: ev.docs || 1 },
  score,
  evidence: {
    docs: ev.docs,
    strong: ev.strong,
    partial: ev.partial,
    weak: 0,
    years: ev.years,
    corpusDocs: ev.corpusDocs,
  },
  topics,
  docIds: ev.docIds,
})

const T = (label, n, matched = true) => ({ label, n, matched })

const doc = (docId, title, year, tier, office, authors, topics) => ({
  docId,
  title,
  year,
  type: 'Report',
  office,
  tier,
  url: 'https://www.wri.org/research/' + docId,
  authors,
  topics,
  geographies: ['China'],
  translations: [],
})

const A = (key, name) => ({ key, name, org: false })

const PEOPLE = [
  person(
    'xue, lulu',
    'Xue, Lulu',
    'WRI China',
    1,
    [
      T('Electric Mobility', 9),
      T('Bus Rapid Transit', 4),
      T('Transport decarbonization', 12, false),
    ],
    {
      docs: 6,
      strong: 4,
      partial: 2,
      years: [2019, 2025],
      corpusDocs: 27,
      docIds: ['d1', 'd2'],
    },
  ),
  person(
    'sclar, ryan',
    'Sclar, Ryan',
    'WRI Global',
    0.82,
    [T('Electric Mobility', 5), T('Bus Rapid Transit', 6)],
    {
      docs: 5,
      strong: 3,
      partial: 2,
      years: [2020, 2024],
      corpusDocs: 18,
      docIds: ['d2'],
    },
  ),
  person(
    'pai, madhav',
    'Pai, Madhav',
    'WRI India',
    0.71,
    [T('Bus Rapid Transit', 7)],
    {
      docs: 4,
      strong: 2,
      partial: 2,
      years: [2018, 2023],
      corpusDocs: 31,
      docIds: ['d3'],
    },
  ),
  person(
    'song, su',
    'Song, Su',
    'WRI China',
    0.63,
    [T('Electric Mobility', 3)],
    {
      docs: 3,
      strong: 2,
      partial: 1,
      years: [2021, 2025],
      corpusDocs: 12,
      docIds: ['d1'],
    },
  ),
  person(
    'mahendra, anjali',
    'Mahendra, Anjali',
    'WRI Global',
    0.55,
    [T('Transport decarbonization', 8, false)],
    {
      docs: 3,
      strong: 1,
      partial: 2,
      years: [2017, 2022],
      corpusDocs: 40,
      docIds: ['d3'],
    },
  ),
  person(
    'li, xiangyi',
    'Li, Xiangyi',
    'WRI China',
    0.44,
    [T('Electric Mobility', 2)],
    {
      docs: 2,
      strong: 1,
      partial: 1,
      years: [2022, 2024],
      corpusDocs: 9,
      docIds: ['d1'],
    },
  ),
  person(
    'adriazola-steil, claudia',
    'Adriazola-Steil, Claudia',
    'WRI US',
    0.36,
    [T('Bus Rapid Transit', 2)],
    {
      docs: 2,
      strong: 1,
      partial: 1,
      years: [2019, 2021],
      corpusDocs: 14,
      docIds: ['d2'],
    },
  ),
  person(
    'wanjohi-opil, hellen',
    'Wanjohi-Opil, Hellen',
    'WRI Africa',
    0.28,
    [T('Bus Rapid Transit', 1)],
    {
      docs: 1,
      strong: 1,
      partial: 0,
      years: [2023, 2023],
      corpusDocs: 6,
      docIds: ['d3'],
    },
  ),
]

const DOCS = {
  d1: doc(
    'd1',
    'Charging Toward 2035: Electric Bus Fleets in Chinese Cities',
    2025,
    'strong',
    'WRI China',
    [A('xue, lulu', 'Xue, Lulu'), A('song, su', 'Song, Su')],
    ['Electric Mobility'],
  ),
  d2: doc(
    'd2',
    'Bus Rapid Transit Financing Models',
    2024,
    'strong',
    'WRI Global',
    [A('sclar, ryan', 'Sclar, Ryan'), A('xue, lulu', 'Xue, Lulu')],
    ['Bus Rapid Transit'],
  ),
  d3: doc(
    'd3',
    'Compact Urban Growth and Mobility in Indian Cities',
    2023,
    'partial',
    'WRI India',
    [A('pai, madhav', 'Pai, Madhav')],
    ['Bus Rapid Transit'],
  ),
}

const base = (over = {}) => ({
  ok: true,
  query: 'electric buses',
  mode: 'evidence',
  understanding: {
    matched_topics: [
      { label: 'Electric Mobility', cosine: 0.66, df: 20 },
      { label: 'Bus Rapid Transit', cosine: 0.51, df: 33 },
    ],
    matched_geographies: [{ label: 'China', cosine: 0.41, df: 49 }],
    likely_off_topic: false,
    suggestions: [],
    degraded: [],
    ...(over.understanding || {}),
  },
  people: PEOPLE,
  total_people: 38,
  total_works: 201,
  docs: DOCS,
  organizations: [{ name: 'Coalition for Urban Transitions', docs: 9 }],
  usage: null,
  timing: { query_ms: 2100, tags_ms: 90, db_ms: 40, rank_ms: 5 },
  ...over,
})

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`,
  )
}

async function rowOpacities(page) {
  return page.$$eval('.experts-row', (els) =>
    els.map((e) => ({
      name: (e.textContent || '').slice(0, 26).trim(),
      opacity: getComputedStyle(e).opacity,
      bg: getComputedStyle(e).backgroundColor,
    })),
  )
}

module.exports = { base }

if (require.main === module)
  (async () => {
    const browser = await chromium.launch()
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    })
    let payload = base()
    await page.route('**/api/experts', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      }),
    )
    await page.route('**/api/experts-mode-query-logs', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: '{}',
      }),
    )

    // ---- 1. Results at rest: the C-1 regression ----
    await page.goto(`${BASE}/experts?q=electric%20buses`, {
      waitUntil: 'networkidle',
    })
    await page.waitForSelector('.experts-row')
    let rows = await rowOpacities(page)
    const faded = rows.filter((r) => parseFloat(r.opacity) < 1)
    check(
      'C-1 at rest: every row is full opacity',
      faded.length === 0,
      faded.length
        ? `${faded.length}/${rows.length} faded, e.g. ${faded[0].name} @ ${faded[0].opacity}`
        : `${rows.length} rows @ 1`,
    )
    await page.screenshot({
      path: `${OUT}/walk-1-results-at-rest.png`,
      fullPage: true,
    })

    // ---- 2. Topic hover: the behaviour C-1's attribute exists for ----
    await page.focus('button[aria-label="Remove Electric Mobility"]')
    await page.waitForTimeout(150)
    rows = await rowOpacities(page)
    const withTopic = rows.filter((r) => parseFloat(r.opacity) === 1)
    const without = rows.filter((r) => parseFloat(r.opacity) < 1)
    check(
      'U14 topic hover: some rows dim, some stay lit',
      withTopic.length > 0 && without.length > 0,
      `${withTopic.length} lit / ${without.length} dimmed`,
    )
    await page.screenshot({
      path: `${OUT}/walk-2-topic-hover.png`,
      fullPage: true,
    })
    await page.evaluate(
      () => document.activeElement && document.activeElement.blur(),
    )
    await page.waitForTimeout(150)

    // ---- 3. Selection: evidence panel + ink halo ----
    await page.click('.experts-row')
    await page.waitForSelector('#experts-evidence-panel')
    const focused = await page.evaluate(
      () =>
        document.activeElement &&
        document.activeElement.tagName +
          ':' +
          (document.activeElement.textContent || '').slice(0, 20),
    )
    check(
      'U13 focus moves into the evidence panel on open',
      !!focused && !/^BODY/.test(focused),
      String(focused),
    )
    const rowStyles = await page.$$eval('.experts-row', (els) =>
      els.map((e) => ({
        pressed: e.getAttribute('aria-pressed'),
        peer: e.getAttribute('data-peer'),
        blw: getComputedStyle(e).borderLeftWidth,
        blc: getComputedStyle(e).borderLeftColor,
        bg: getComputedStyle(e).backgroundColor,
      })),
    )
    const sel = rowStyles.find((r) => r.pressed === 'true')
    check(
      'spec §8: the selected row carries an ink left rule',
      !!sel && parseFloat(sel.blw) > 0,
      sel ? `border-left ${sel.blw} ${sel.blc}` : 'no pressed row',
    )
    check(
      'spec §8: the selected row is washed, not bare',
      !!sel && sel.bg !== 'rgba(0, 0, 0, 0)',
      sel ? `bg ${sel.bg}` : 'no pressed row',
    )
    const peer = rowStyles.find(
      (r) => r.peer === 'true' && r.pressed !== 'true',
    )
    check(
      'spec §8: peer rows carry the gold tint',
      !!peer && peer.bg !== 'rgba(0, 0, 0, 0)',
      peer ? `bg ${peer.bg}` : 'no peer row',
    )
    // Paint order: in SVG a later sibling covers an earlier one, so a node drawn
    // after a label overdraws it. A bounding-box comparison between labels misses
    // this entirely — the collision is label vs CIRCLE.
    const covered = await page.$$eval('svg[role="img"]', (svgs) => {
      const svg = svgs[0]
      const all = Array.from(svg.querySelectorAll('*'))
      const labels = Array.from(
        svg.querySelectorAll('[data-testid="person-label"]'),
      )
      const nodes = Array.from(
        svg.querySelectorAll('[data-testid="person-node"] circle'),
      )
      const vis = (el) => {
        const g = el.closest('g')
        return parseFloat(getComputedStyle(g || el).opacity || '1') > 0.5
      }
      const hit = (a, b) =>
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height
      const out = []
      for (const l of labels) {
        if (!vis(l)) continue
        const lb = l.getBoundingClientRect()
        if (!lb.width) continue
        for (const c of nodes) {
          if (
            !vis(c) ||
            !c.getAttribute('r') ||
            c.getAttribute('fill') === 'transparent'
          )
            continue
          const cb = c.getBoundingClientRect()
          if (hit(lb, cb) && all.indexOf(c) > all.indexOf(l))
            out.push((l.textContent || '').trim())
        }
      }
      return out
    })
    check(
      'no person label is overdrawn by a node painted after it',
      covered.length === 0,
      covered.length ? covered.join(', ') : 'none',
    )

    const tab = await page.$$eval('[data-testid="person-name-tab"]', (els) => {
      if (!els.length) return null
      const r = els[0].getBoundingClientRect()
      const t = els[0].parentElement.querySelector(
        '[data-testid="person-label"]',
      )
      const tr = t.getBoundingClientRect()
      return {
        tabRight: r.x + r.width,
        textRight: tr.x + tr.width,
        text: (t.textContent || '').trim(),
      }
    })
    check(
      'the ink name tab is wide enough for the name it backs',
      !!tab && tab.tabRight >= tab.textRight,
      tab
        ? `"${tab.text}" text ends ${Math.round(tab.textRight - tab.tabRight)}px past the tab`
        : 'no tab',
    )

    await page.screenshot({
      path: `${OUT}/walk-3-selected.png`,
      fullPage: true,
    })

    // ---- 4. Degraded: no-match wording, no fake cosine ----
    payload = base({
      understanding: {
        matched_topics: [
          { label: 'Electric Mobility', cosine: 1, df: 20 },
          { label: 'Bus Rapid Transit', cosine: 0.42, df: 33 },
        ],
        matched_geographies: [],
        likely_off_topic: false,
        suggestions: [],
        degraded: ['tags_nearby:topic_no_match'],
      },
    })
    await page.goto(`${BASE}/experts?q=electric%20buses`, {
      waitUntil: 'networkidle',
    })
    await page.waitForSelector('.experts-row')
    const body = await page.textContent('body')
    check(
      'I-1 no-match is explained, not called an outage',
      /No topic in the library matched/.test(body) &&
        !/Topic matching is unavailable/.test(body),
    )
    check(
      'U3 doc-derived strength is not shown as a cosine',
      !/\b1\.00\b/.test(body),
    )
    check(
      'I-3 caption does not claim a query match',
      /topics from the matched documents/.test(body) &&
        !/topics sized by match to the query/.test(body),
    )
    rows = await rowOpacities(page)
    check(
      'C-1 holds on the degraded path too',
      rows.every((r) => parseFloat(r.opacity) === 1),
      `${rows.length} rows`,
    )
    await page.screenshot({
      path: `${OUT}/walk-4-degraded.png`,
      fullPage: true,
    })

    // ---- 5. Error state ----
    await page.unroute('**/api/experts')
    await page.route('**/api/experts', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'internal error' }),
      }),
    )
    await page.goto(`${BASE}/experts?q=electric%20buses`, {
      waitUntil: 'networkidle',
    })
    await page.waitForSelector('[role="alert"]')
    const errBody = await page.textContent('body')
    check(
      'U8 error state shows human copy, not the raw upstream string',
      !/internal error/.test(errBody),
    )
    check(
      'M-5 no stale bench under the error',
      (await page.$$('.experts-row')).length === 0,
    )
    await page.screenshot({ path: `${OUT}/walk-5-error.png`, fullPage: true })

    await browser.close()
    const failed = results.filter((r) => !r.pass)
    console.log(
      `\n${results.length - failed.length}/${results.length} checks passed`,
    )
    console.log(`screenshots: ${OUT}`)
    process.exit(failed.length ? 1 : 0)
  })().catch((e) => {
    console.error(e)
    process.exit(2)
  })
