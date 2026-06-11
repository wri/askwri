export interface ReindexResult {
  ok: boolean
  error?: string
}

/**
 * Best-effort BM25 refresh after lifecycle changes. The dense lane filters
 * status='searchable' per query; the in-memory BM25 lane only refreshes via
 * POST /reindex (or service restart) — see docs/document-management.md §4.
 */
export async function triggerReindex(): Promise<ReindexResult> {
  const base = process.env.SEARCH_SERVICE_URL || process.env.LLAMAINDEX_SERVICE_URL
  if (!base) return { ok: false, error: 'SEARCH_SERVICE_URL not configured' }
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/reindex`, {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) return { ok: false, error: `reindex returned HTTP ${res.status}` }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) }
  }
}
