/**
 * Catalog API
 *  - Reads a CSV (or JSON) catalog from disk
 *  - Normalizes keys to lowercase
 *  - Serves an array of { file_id, external_file_id, file_name, meta }
 *
 * HOW IT FINDS THE FILE:
 *  1) process.env.FILE_METADATA_PATH (absolute or relative to project root)
 *  2) Unified document database: /tmp/askWRI_docs/documents.csv (new unified format with import batch tracking)
 */

import { NextRequest, NextResponse } from 'next/server'
import path from 'node:path'
import fs from 'node:fs/promises'
import { initializeDatabase } from '../../../db/data-source'
import { getCatalogItems } from '../../../db/queries/getCatalogItems'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

function norm(s: string) {
  return s.trim().toLowerCase()
}
function normalizeKeys(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj || {})) out[norm(k)] = v
  return out
}

async function exists(p: string) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function detectCatalogPath(): Promise<string> {
  const root = process.cwd()
  const envPath = process.env.FILE_METADATA_PATH
    ? path.resolve(root, process.env.FILE_METADATA_PATH)
    : ''
  // Prioritize unified document database, then fall back to legacy paths
  const candidates = [
    envPath,
    path.join('/tmp', 'askWRI_docs', 'documents.csv'), // New unified database (priority)
  ].filter(Boolean)
  console.log('[detectCatalogPath] root:', root)
  console.log('[detectCatalogPath] envPath:', envPath)
  console.log('[detectCatalogPath] candidates:', candidates)
  for (const p of candidates) {
    const found = p && (await exists(p))
    console.log(`[detectCatalogPath] Checking: ${p} => ${found}`)
    if (found) return p
  }
  throw new Error(
    'No catalog CSV/JSON found. Define FILE_METADATA_PATH or place documents.csv under /tmp/askWRI_docs.',
  )
}

function parseCSV(text: string): Array<Record<string, string>> {
  // Minimal robust CSV parser: handles quotes, commas, newlines
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQ = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') {
        const peek = text[i + 1]
        if (peek === '"') {
          cur += '"'
          i++
        } else {
          inQ = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') inQ = true
    else if (ch === ',') {
      row.push(cur)
      cur = ''
    } else if (ch === '\n' || ch === '\r') {
      // if CRLF or LF, finalize row on first breaker
      if (cur.length > 0 || row.length > 0) {
        row.push(cur)
        cur = ''
        rows.push(row)
        row = []
      }
      // swallow following LF in CRLF
      if (ch === '\r' && text[i + 1] === '\n') i++
    } else {
      cur += ch
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur)
    rows.push(row)
  }
  if (rows.length === 0) return []

  const headers = rows[0].map((h) => norm(h))
  const out: Array<Record<string, string>> = []
  for (let r = 1; r < rows.length; r++) {
    const vals = rows[r]
    if (vals.every((v) => !v || !v.trim())) continue
    const obj: Record<string, string> = {}
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = (vals[c] ?? '').trim()
    }
    out.push(obj)
  }
  return out
}

function normalizeRow(row: Record<string, string>) {
  // Try typical id/name columns; keep everything in meta
  const meta = normalizeKeys(row)
  const file_id =
    meta.file_id ||
    meta['file id'] ||
    meta.pipeline_file_id ||
    meta['pipeline file id'] ||
    ''
  const file_name =
    meta.file_name ||
    meta['file name'] ||
    meta.external_file_id ||
    meta['external file id'] ||
    meta.file_path ||
    meta['file path'] ||
    ''
  const external_file_id =
    meta.external_file_id || meta['external file id'] || ''
  return { file_id, file_name, external_file_id, meta }
}

export async function GET(_req: NextRequest) {
  try {
    // Postgres is the default catalog source now that the corpus lives in
    // the database. CSV fallback is only for the legacy retrieval backend
    // (RETRIEVAL_BACKEND=legacy) or explicit opt-in via CATALOG_SOURCE=csv.
    if (process.env.CATALOG_SOURCE === 'csv') {
      const p = await detectCatalogPath()
      const buf = await fs.readFile(p, 'utf8')
      let items: Array<Record<string, any>> = []

      if (p.endsWith('.json')) {
        const arr = JSON.parse(buf)
        if (!Array.isArray(arr)) throw new Error('JSON catalog must be an array')
        items = arr.map((row: any) => normalizeRow(row))
      } else {
        const rows = parseCSV(buf)
        items = rows.map(normalizeRow)
      }

      // de-dupe by (file_id || file_name)
      const seen = new Set<string>()
      const uniq: typeof items = []
      for (const it of items) {
        const key = it.file_id || it.file_name
        if (!key) continue
        if (seen.has(key)) continue
        seen.add(key)
        uniq.push(it)
      }

      return NextResponse.json({
        ok: true,
        count: uniq.length,
        updatedAt: new Date().toISOString(),
        items: uniq,
        source: path.basename(p),
      })
    }

    // Default: postgres
    await initializeDatabase()
    const items = await getCatalogItems()
    return NextResponse.json({
      ok: true,
      count: items.length,
      updatedAt: new Date().toISOString(),
      items,
      source: 'postgres',
    })
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 },
    )
  }
}
