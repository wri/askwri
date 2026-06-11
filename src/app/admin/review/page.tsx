'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Box, Heading, Text } from '@chakra-ui/react'
import { adminFetch } from '../lib/api'

interface QueueItem {
  id: string
  externalId: string
  title: string | null
  language: string | null
  status: string
  extractionConfidence: number | null
  jobStatus: string | null
  jobError: string | null
  jobAttempts: number | null
  suggestedTagCount: number
  createdAt: string
}

const cell: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #eee' }

const ReviewQueuePage = () => {
  const [items, setItems] = useState<QueueItem[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const body = await adminFetch<{ items: QueueItem[] }>('/api/admin/review-queue')
      setItems(body.items)
      setError(null)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const act = async (id: string, action: 'promote' | 'reingest') => {
    setBusyId(id)
    setNotice(null)
    setError(null)
    try {
      if (action === 'promote') {
        await adminFetch(`/api/admin/documents/${id}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'searchable' }),
        })
        setNotice('Promoted to searchable.')
      } else {
        await adminFetch(`/api/admin/documents/${id}/reingest`, { method: 'POST' })
        setNotice('Re-queued for ingestion.')
      }
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Box>
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Review queue
      </Heading>
      <Text style={{ marginBottom: 16, color: '#555' }}>
        Documents flagged by the ingestion pipeline (low extraction confidence or errored jobs).
        Open a document to review metadata and suggested tags before promoting.
      </Text>
      {notice && <Text style={{ color: '#0A6640', marginBottom: 12 }}>{notice}</Text>}
      {error && <Text style={{ color: '#C11101', marginBottom: 12 }}>{error}</Text>}
      {items.length === 0 ? (
        <Text>Queue is empty. 🎉</Text>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              {['Document', 'Lang', 'Status', 'Confidence', 'Job', 'Suggested tags', 'Actions'].map(
                (h) => (
                  <th key={h} style={{ ...cell, textAlign: 'left', background: '#f7f7f7' }}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td style={cell}>
                  <Link href={`/admin/documents/${item.id}`} style={{ textDecoration: 'underline' }}>
                    {item.title || item.externalId}
                  </Link>
                </td>
                <td style={cell}>{item.language ?? '—'}</td>
                <td style={cell}>{item.status}</td>
                <td style={cell}>
                  {item.extractionConfidence != null ? item.extractionConfidence.toFixed(2) : '—'}
                </td>
                <td style={cell} title={item.jobError ?? undefined}>
                  {item.jobStatus ?? '—'}
                  {item.jobError ? ` ⚠ (${item.jobAttempts} attempts)` : ''}
                </td>
                <td style={cell}>{item.suggestedTagCount}</td>
                <td style={cell}>
                  <button
                    disabled={busyId === item.id}
                    onClick={() => act(item.id, 'promote')}
                    style={{ marginRight: 8, textDecoration: 'underline' }}
                  >
                    Promote
                  </button>
                  <button
                    disabled={busyId === item.id}
                    onClick={() => act(item.id, 'reingest')}
                    style={{ textDecoration: 'underline' }}
                  >
                    Re-ingest
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Box>
  )
}

export default ReviewQueuePage
