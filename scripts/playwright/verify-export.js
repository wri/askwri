/* Playwright walk of the catalog metadata export.
 *
 * WHY THIS EXISTS, given a green Jest suite: the export control is a bare
 * <a href> that hands the CSV to the browser. jsdom never navigates, never
 * fires a download, and (as verify-experts.js documents at length) never
 * computes style — so "the link exists" is the only thing a unit test can
 * honestly assert. Three real failure modes live outside that:
 *
 *   - the route is reachable without a session (metadata leak);
 *   - the control renders as invisible/unstyled text (the class of bug that
 *     shipped past unit tests four times on /experts);
 *   - the CSV that actually lands on disk is malformed, or has drifted from
 *     the import template so it can no longer be re-imported.
 *
 * Scope: one logged-in admin, one download, no search service. Needs Postgres
 * with at least a few documents; does not touch S3 or the search service.
 *
 * Run:
 *   DATABASE_URL=... npm run dev -- -p 3100   # in another shell
 *   npx playwright install chromium           # first time only
 *   npm run verify:export
 *
 * Env: BASE_URL (default http://localhost:3100), ADMIN_USER / ADMIN_PASSWORD
 *      (default admin / admin-local-password), EXPECTED_DOCS (optional).
 *
 * Exits non-zero if any check fails.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright')

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100'
const USER = process.env.ADMIN_USER || 'admin'
const PASS = process.env.ADMIN_PASSWORD || 'admin-local-password'

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

// Minimal RFC 4180 parser: quoted cells, doubled quotes, embedded newlines.
function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (ch !== '\r') cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

;(async () => {
  const browser = await chromium.launch()
  const context = await browser.newContext({ acceptDownloads: true })

  // 1. The route must refuse an anonymous caller before anything else runs.
  const anon = await context.request.get(
    `${BASE_URL}/api/admin/documents/export`,
  )
  check(
    'export refuses an anonymous request',
    anon.status() === 401,
    `status ${anon.status()}`,
  )

  const page = await context.newPage()

  // 2. Authenticate through the real login endpoint. Using the API instead of
  //    typing into the form keeps this deterministic: React hydration can
  //    swallow a fill() and leave the submit button disabled.
  const login = await context.request.post(`${BASE_URL}/api/admin/auth/login`, {
    data: { username: USER, password: PASS },
  })
  check(
    'admin login succeeds',
    login.status() === 200,
    `status ${login.status()}`,
  )

  await page.goto(`${BASE_URL}/admin/documents`, {
    waitUntil: 'domcontentloaded',
  })
  check(
    'authenticated admin stays on /admin/documents',
    new URL(page.url()).pathname === '/admin/documents',
    page.url(),
  )
  await page.getByRole('heading', { name: 'Document catalog' }).waitFor()

  // 3. The control exists at the top of the page, as a real anchor.
  const link = page.getByRole('link', { name: /Export metadata \(CSV\)/ })
  const count = await link.count()
  check('export control is present', count === 1, `${count} matches`)
  if (count !== 1) throw new Error('cannot continue without the export control')

  const href = await link.getAttribute('href')
  check(
    'export control points at the export route',
    href === '/api/admin/documents/export',
    href,
  )

  const box = await link.boundingBox()
  check(
    'export control has a non-zero box',
    !!box && box.width > 40 && box.height > 10,
    box && `${Math.round(box.width)}x${Math.round(box.height)}`,
  )

  // 4. It must actually look like a control (computed style, not the markup).
  const style = await link.evaluate((el) => {
    const s = getComputedStyle(el)
    return {
      borderWidth: parseFloat(s.borderTopWidth) || 0,
      borderStyle: s.borderTopStyle,
      cursor: s.cursor,
      color: s.color,
      visibility: s.visibility,
      opacity: parseFloat(s.opacity),
    }
  })
  check(
    'export control renders as a bordered control, not bare text',
    style.borderWidth > 0 &&
      style.borderStyle !== 'none' &&
      style.visibility === 'visible' &&
      style.opacity === 1,
    JSON.stringify(style),
  )
  check(
    'export control shows a pointer cursor',
    style.cursor === 'pointer',
    style.cursor,
  )

  // 5. It sits at the top: above the filter bar and the document table.
  const tableTop = await page
    .locator('table')
    .first()
    .boundingBox()
    .then((b) => (b ? b.y : Infinity))
  check(
    'export control sits above the document table',
    !!box && box.y < tableTop,
    `control y=${box && Math.round(box.y)} table y=${Math.round(tableTop)}`,
  )

  // 6. Clicking it downloads a CSV, authorised by the session cookie.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    link.click(),
  ])
  const suggested = download.suggestedFilename()
  const today = new Date().toISOString().slice(0, 10)
  check(
    'download filename is dated and ends .csv',
    suggested === `askwri-metadata-${today}.csv`,
    suggested,
  )

  const saved = path.join(os.tmpdir(), `pw-export-${Date.now()}.csv`)
  await download.saveAs(saved)
  const csv = fs.readFileSync(saved, 'utf8')
  check('downloaded file is non-empty', csv.length > 0, `${csv.length} bytes`)

  // 7. Header must equal the header the import template serves, so the file
  //    stays re-importable. Fetched from the app rather than hardcoded here.
  const templateRes = await context.request.get(
    `${BASE_URL}/api/admin/import/template`,
  )
  const templateHeader = (await templateRes.text()).split('\n')[0].trim()

  const rows = parseCsv(csv)
  const header = rows[0].join(',')
  check(
    'export header matches the import template',
    header === templateHeader,
    header === templateHeader
      ? ''
      : `export=${header} template=${templateHeader}`,
  )

  const body = rows.slice(1)
  // Guard the vacuity trap: the row-width and order checks below would all
  // pass on an empty export.
  check(
    'export contains at least one row',
    body.length > 0,
    `${body.length} rows`,
  )
  const widths = new Set(body.map((r) => r.length))
  check(
    'every row has the header width',
    widths.size === 1 && widths.has(rows[0].length),
    `widths=${[...widths].join(',')}`,
  )

  if (process.env.EXPECTED_DOCS) {
    check(
      'row count matches EXPECTED_DOCS',
      String(body.length) === process.env.EXPECTED_DOCS,
      `${body.length}`,
    )
  }

  const col = (r, name) => r[rows[0].indexOf(name)]
  const byId = new Map(body.map((r) => [col(r, 'external_id'), r]))

  // 8. Field mapping, on a multi-language doc.
  const es = byId.get('pw-es-2')
  check('multi-language doc is exported', !!es)
  if (es) {
    check(
      'languages are rendered as importable names',
      col(es, 'languages') === 'Spanish, English',
      col(es, 'languages'),
    )
    check(
      'date_published is M/D/YYYY as the importer expects',
      col(es, 'date_published') === '6/1/2022',
      col(es, 'date_published'),
    )
    check(
      'file_path is the bare filename',
      col(es, 'file_path') === 'pw-es-2.pdf',
      col(es, 'file_path'),
    )
  }

  // 9. Authoritative summary beats the legacy source_metadata fallback.
  const en = byId.get('pw-en-1')
  check(
    'english doc summary comes from document_summaries',
    !!en &&
      col(en, 'summary') === 'Authoritative long summary for the export test.',
    en && col(en, 'summary'),
  )

  // 10. The nasty cell: comma + embedded quote + newline must survive. This
  //     doc is also the all-NULLs case (doi, url, date, publication_title).
  const q = byId.get('pw-quote-3')
  check(
    'summary with comma/quote/newline round-trips',
    !!q &&
      col(q, 'summary') ===
        'He said "hello", then left.\nSecond line after a break.',
    q && JSON.stringify(col(q, 'summary')),
  )
  check(
    'NULL cells export as empty, not the string "null"',
    !!q &&
      col(q, 'doi') === '' &&
      col(q, 'url') === '' &&
      col(q, 'date_published') === '' &&
      col(q, 'publication_title') === '',
    q &&
      JSON.stringify([
        col(q, 'doi'),
        col(q, 'url'),
        col(q, 'date_published'),
        col(q, 'publication_title'),
      ]),
  )

  // 11. Export must cover every status, not just searchable documents
  //     (pw-quote-3 is 'withdrawn').
  check(
    'non-searchable (withdrawn) documents are included',
    byId.has('pw-quote-3'),
  )

  // 12. Row order is stable (external_id ascending).
  const ids = body.map((r) => col(r, 'external_id'))
  check(
    'rows are ordered by external_id',
    JSON.stringify(ids) === JSON.stringify([...ids].sort()),
    ids.join(','),
  )

  await browser.close()

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('\nAll export checks passed.')
})().catch((err) => {
  console.error('\nverify-export crashed:', err.message)
  process.exit(1)
})
