'use client'

import { useRef, useState } from 'react'
import { Box, Heading, Text } from '@chakra-ui/react'
import { adminFetch } from '../lib/api'

interface FieldChange {
  field: string
  before: string | null
  after: string | null
  overwrite: boolean
  protected: boolean
}

interface RowDecision {
  externalId: string
  action: 'created' | 'updated' | 'skipped' | 'error'
  reason?: string
  changes?: FieldChange[]
  warnings?: string[]
  matchKey?: string
}

interface ImportResult {
  ok: boolean
  created: number
  updated: number
  skipped: number
  jobs: number
  decisions?: RowDecision[]
}

/**
 * Minimal CSV parser: handles quoted fields with embedded commas and
 * doubled-quote escaping (""), matching the documents.csv format.
 */
function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++ } else { inQ = false }
      } else { cur += ch }
    } else if (ch === '"') { inQ = true }
    else if (ch === ',') { row.push(cur); cur = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); cur = ''; row = [] }
    } else { cur += ch }
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row) }
  return rows
}

/**
 * Parse the CSV into rows. Auto-detects legacy (JSON blob with a 'metadata'
 * column) vs flat format (DB column names). Returns an array of row objects
 * suitable for POSTing to /api/import-documents.
 */
function csvToRows(text: string): { rows: any[]; isFlat: boolean } {
  const rows = parseCSV(text)
  if (rows.length < 2) return { rows: [], isFlat: false }
  const headers = rows[0].map((h) => h.trim().toLowerCase())
  const hasMetadataCol = headers.includes('metadata')
  const out: any[] = []
  for (let r = 1; r < rows.length; r++) {
    const vals = rows[r]
    if (vals.every((v) => !v || !v.trim())) continue
    if (hasMetadataCol) {
      // Legacy format: file_path, metadata (JSON), summary
      const fpIdx = headers.indexOf('file_path')
      const metaIdx = headers.indexOf('metadata')
      const sumIdx = headers.indexOf('summary')
      const file_path = fpIdx >= 0 ? (vals[fpIdx] ?? '').trim() : ''
      const metadataStr = metaIdx >= 0 ? (vals[metaIdx] ?? '').trim() : '{}'
      const summary = sumIdx >= 0 ? (vals[sumIdx] ?? '').trim() : ''
      let metadata: Record<string, any> = {}
      try { metadata = JSON.parse(metadataStr) } catch { /* leave empty */ }
      out.push({ file_path, metadata, summary: summary || undefined })
    } else {
      // Flat format: each column maps directly to a field
      const obj: Record<string, string> = {}
      for (let c = 0; c < headers.length; c++) {
        const val = (vals[c] ?? '').trim()
        if (val) obj[headers[c]] = val
      }
      out.push(obj)
    }
  }
  return { rows: out, isFlat: !hasMetadataCol }
}

const ImportPage = () => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [parsedRows, setParsedRows] = useState<any[] | null>(null)
  const [isFlat, setIsFlat] = useState(false)
  const [decisions, setDecisions] = useState<RowDecision[] | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleFile = () => {
    const file = inputRef.current?.files?.[0]
    if (!file) { setError('Select a CSV file first.'); return }
    setError(null); setNotice(null); setDecisions(null); setResult(null)
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      const { rows, isFlat } = csvToRows(text)
      if (rows.length === 0) {
        setError('No valid rows found. Use the template (Download template) for the correct format.')
        return
      }
      setParsedRows(rows)
      setIsFlat(isFlat)
      setNotice(`${rows.length} row(s) parsed from ${file.name} (${isFlat ? 'flat' : 'legacy'} format). Click "Preview" for a dry-run, or "Apply" to import.`)
    }
    reader.onerror = () => setError('Failed to read the CSV file.')
    reader.readAsText(file)
  }

  const handlePreview = async () => {
    if (!parsedRows || parsedRows.length === 0) { setError('Select and parse a CSV file first.'); return }
    setBusy(true); setError(null); setNotice(null); setResult(null)
    try {
      const body = await adminFetch<ImportResult>('/api/import-documents', {
        method: 'POST',
        body: JSON.stringify({ rows: parsedRows, dryRun: true }),
      })
      setDecisions(body.decisions ?? [])
      setNotice(`Dry-run complete: ${body.created} would be created, ${body.updated} updated, ${body.skipped} skipped.`)
    } catch (err: any) { setError(err.message) }
    finally { setBusy(false) }
  }

  const handleApply = async () => {
    if (!parsedRows || parsedRows.length === 0) { setError('Select and parse a CSV file first.'); return }
    setBusy(true); setError(null); setNotice(null); setDecisions(null)
    try {
      const body = await adminFetch<ImportResult>('/api/import-documents', {
        method: 'POST',
        body: JSON.stringify({ rows: parsedRows }),
      })
      setResult(body)
      setNotice(`Import applied: ${body.created} created, ${body.updated} updated, ${body.skipped} skipped, ${body.jobs} jobs queued.`)
    } catch (err: any) { setError(err.message) }
    finally { setBusy(false) }
  }

  const actionColor: Record<string, string> = {
    created: '#0A6640', updated: '#0050C8', skipped: '#888', error: '#C11101',
  }

  return (
    <Box style={{ paddingBottom: 48 }}>
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Import metadata from CSV
      </Heading>
      <Text style={{ marginBottom: 8, color: '#555' }}>
        Upload a CSV file with document metadata. Each row creates or updates a document. The flat
        format uses <strong>DB column names</strong> (file_path, external_id, doi, title, authors,
        year_published, etc.) — flat imports <strong>overwrite</strong> existing values with
        warnings. The legacy format (file_path, metadata JSON blob, summary) uses fill-only-empty
        (seed) semantics.
      </Text>
      <Text style={{ marginBottom: 16, color: '#555', fontStyle: 'italic' }}>
        Click <strong>Preview</strong> for a safe dry-run (no changes are written), then{' '}
        <strong>Apply</strong> to import for real.
      </Text>

      {/* Download template link */}
      <Box style={{ marginBottom: 16 }}>
        <a
          href='/api/admin/import/template'
          style={{ textDecoration: 'underline', color: '#0050C8', fontSize: 14 }}
        >
          ↓ Download CSV template
        </a>
      </Box>

      {notice && <Text style={{ color: '#0A6640', marginBottom: 12 }}>{notice}</Text>}
      {error && <Text style={{ color: '#C11101', marginBottom: 12 }}>{error}</Text>}

      <div style={{ marginBottom: 12 }}>
        <input
          ref={inputRef}
          type='file'
          accept='.csv'
          aria-label='CSV file'
          style={{ marginBottom: 8 }}
        />
        <button
          onClick={handleFile}
          style={{ padding: '4px 12px', marginRight: 8, cursor: 'pointer' }}
        >
          Load CSV
        </button>
        <button
          disabled={busy || !parsedRows}
          onClick={handlePreview}
          style={{ padding: '4px 12px', marginRight: 8, cursor: busy || !parsedRows ? 'not-allowed' : 'pointer' }}
        >
          Preview
        </button>
        <button
          disabled={busy || !parsedRows}
          onClick={handleApply}
          style={{ padding: '4px 12px', cursor: busy || !parsedRows ? 'not-allowed' : 'pointer' }}
        >
          Apply
        </button>
      </div>

      {/* Dry-run decisions table with field changes + warnings */}
      {decisions && decisions.length > 0 && (
        <Box style={{ marginTop: 16 }}>
          <Heading size='sm' style={{ marginBottom: 8 }}>Dry-run preview ({decisions.length} rows)</Heading>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>External ID</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Action</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Match key</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Changes / Warnings</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d, i) => (
                <tr key={i}>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid #eee' }}>{d.externalId || '—'}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid #eee', color: actionColor[d.action] ?? '#333', fontWeight: 600 }}>{d.action}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid #eee', color: '#888', fontSize: 13 }}>{d.matchKey ?? '—'}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid #eee', fontSize: 13 }}>
                    {d.changes && d.changes.length > 0 ? (
                      <Box>
                        {d.changes.map((c, ci) => (
                          <div key={ci} style={{
                            color: c.protected ? '#C11101' : c.overwrite ? '#B8860B' : '#0A6640',
                            marginBottom: 2,
                          }}>
                            {c.protected
                              ? `🔒 ${c.field}: protected (human edit)`
                              : c.overwrite
                                ? `⚠ ${c.field}: "${c.before}" → "${c.after}" (overwrite)`
                                : `${c.field}: → "${c.after}" (new)`}
                          </div>
                        ))}
                      </Box>
                    ) : (
                      <span style={{ color: '#888' }}>{d.reason ?? '—'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Box>
      )}

      {/* Apply result summary */}
      {result && (
        <Box style={{ marginTop: 16, padding: 12, border: '1px solid #ddd', borderRadius: 4, background: '#f7f7f7' }}>
          <Heading size='sm' style={{ marginBottom: 8 }}>Import result</Heading>
          <Text>Created: {result.created} · Updated: {result.updated} · Skipped: {result.skipped} · Jobs queued: {result.jobs}</Text>
        </Box>
      )}
    </Box>
  )
}

export default ImportPage
