'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { adminFetch } from '../lib/api'

interface QueueRef {
  id: string
  status: string
}

/**
 * ReviewBar — pinned guided-pass controls shown on the document editor
 * whenever the open document is currently in the review queue. Fetches the
 * queue itself; a successful action response is authoritative for advancing
 * (queue refetches can transiently still contain a just-promoted doc via a
 * stale errored-job row).
 */
export const ReviewBar = ({
  documentId,
  documentStatus,
  onChanged,
}: {
  documentId: string
  documentStatus: string | undefined
  onChanged: () => void
}) => {
  const router = useRouter()
  const [queue, setQueue] = useState<QueueRef[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    adminFetch<{ items?: QueueRef[] }>('/api/admin/review-queue')
      .then((body) => setQueue(body.items ?? []))
      .catch(() => setQueue([])) // bar is best-effort; never block the editor
  }, [documentId])

  const idx = queue ? queue.findIndex((q) => q.id === documentId) : -1
  const nextId =
    queue && idx >= 0 && idx < queue.length - 1 ? queue[idx + 1].id : null
  const prevId = queue && idx > 0 ? queue[idx - 1].id : null

  const advance = useCallback(() => {
    if (nextId) router.push(`/admin/documents/${nextId}`)
    else onChanged() // last doc: stay, refresh the editor's stale detail
  }, [nextId, router, onChanged])

  const act = async (action: 'promote' | 'reingest') => {
    setBusy(true)
    setError(null)
    try {
      if (action === 'promote') {
        await adminFetch(`/api/admin/documents/${documentId}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'searchable' }),
        })
      } else {
        await adminFetch(`/api/admin/documents/${documentId}/reingest`, {
          method: 'POST',
        })
      }
      advance() // success is authoritative — advance regardless of queue staleness
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (queue === null || (queue.length === 0 && idx < 0)) return null

  const barStyle: React.CSSProperties = {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    background: '#1a365d',
    color: '#fff',
    padding: '8px 16px',
    marginBottom: 16,
    borderRadius: 4,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    fontSize: 14,
  }
  const btn: React.CSSProperties = {
    color: '#fff',
    textDecoration: 'underline',
    cursor: 'pointer',
  }

  if (idx < 0) {
    // Doc left the queue (promoted elsewhere / restored) but a pass is in progress.
    return (
      <div style={barStyle} data-testid='review-bar'>
        <span>No longer in the review queue.</span>
        {queue.length > 0 && (
          <button
            style={btn}
            onClick={() => router.push(`/admin/documents/${queue[0].id}`)}
          >
            Next →
          </button>
        )}
      </div>
    )
  }

  return (
    <div style={barStyle} data-testid='review-bar'>
      <span>
        Reviewing {idx + 1} of {queue.length} flagged
      </span>
      {error && <span style={{ color: '#feb2b2' }}>{error}</span>}
      <span style={{ display: 'flex', gap: 12 }}>
        <button
          style={btn}
          disabled={busy || !prevId}
          onClick={() => prevId && router.push(`/admin/documents/${prevId}`)}
        >
          ← Prev
        </button>
        <button
          style={{ ...btn, fontWeight: 700 }}
          disabled={busy || documentStatus === 'error'}
          title={
            documentStatus === 'error'
              ? 'This document errored during ingestion — re-ingest it before promoting.'
              : 'Promote to public search and move to the next flagged document.'
          }
          onClick={() => act('promote')}
        >
          Promote
        </button>
        <button
          style={btn}
          disabled={busy}
          title='Re-run the ingestion pipeline and move to the next flagged document.'
          onClick={() => act('reingest')}
        >
          Re-ingest
        </button>
        <button style={btn} disabled={busy || !nextId} onClick={advance}>
          Skip →
        </button>
      </span>
    </div>
  )
}

export default ReviewBar
