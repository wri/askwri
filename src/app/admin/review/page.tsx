'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Box, Heading, Text } from '@chakra-ui/react'
import { adminFetch } from '../lib/api'
import { StatusChip } from '../components/StatusChip'
import { Tooltip } from '../components/Tooltip'

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

interface CorpusHealth {
  statusCounts: Record<string, number>
  languageCounts: Record<string, number>
  reviewQueueDepth: number
  docsMissingNativeSummary: number
  docsMissingTitleEn: number
  lowConfidenceDocs: number
  worker: {
    status: string
    queueDepth: number
    intakeBacklog: number
    lastProcessedAt: string | null
  }
}

const cell: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid #eee',
}
const WORKER_STYLE: Record<string, { color: string; label: string }> = {
  idle: { color: '#0A6640', label: 'running (idle)' },
  processing: { color: '#0050C8', label: 'running (processing)' },
  pending: {
    color: '#B7791F',
    label: 'files just dropped — worker should pick them up shortly',
  },
  stale: {
    color: '#C11101',
    label: 'NOT RUNNING — dropped files are not being processed',
  },
}

const ReviewQueuePage = () => {
  const [items, setItems] = useState<QueueItem[]>([])
  const [health, setHealth] = useState<CorpusHealth | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [queueBody, healthBody] = await Promise.all([
        adminFetch<{ items: QueueItem[] }>('/api/admin/review-queue'),
        adminFetch<{ health: CorpusHealth }>('/api/admin/corpus-health'),
      ])
      setItems(queueBody.items)
      setHealth(healthBody.health)
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
        setNotice(
          'Promoted to searchable — the document is now in the public corpus.',
        )
      } else {
        await adminFetch(`/api/admin/documents/${id}/reingest`, {
          method: 'POST',
        })
        setNotice(
          'Re-queued for ingestion — the worker will re-parse and re-process this document.',
        )
      }
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleAll = () =>
    setSelected((prev) =>
      prev.size === items.length ? new Set() : new Set(items.map((i) => i.id)),
    )

  const bulkAct = async (action: 'promote' | 'reingest') => {
    const ids = Array.from(selected)
    if (
      !window.confirm(
        action === 'promote'
          ? `Promote ${ids.length} document(s) to public search?`
          : `Re-ingest ${ids.length} document(s)? AI summaries and AI-extracted metadata will be regenerated.`,
      )
    )
      return
    setBulkBusy(true)
    setNotice(null)
    setError(null)
    try {
      const failures: { id: string; reason: string }[] = []
      await Promise.allSettled(
        ids.map(async (id) => {
          try {
            if (action === 'promote') {
              await adminFetch(`/api/admin/documents/${id}/status`, {
                method: 'POST',
                body: JSON.stringify({ status: 'searchable' }),
              })
            } else {
              await adminFetch(`/api/admin/documents/${id}/reingest`, {
                method: 'POST',
              })
            }
          } catch (err: any) {
            failures.push({ id, reason: err.message })
          }
        }),
      )
      const ok = ids.length - failures.length
      setSelected(new Set(failures.map((f) => f.id))) // failed rows stay selected
      await load() // single refetch for the whole batch (also clears any stale page error)
      if (failures.length === 0) {
        setNotice(`${ok} ${action === 'promote' ? 'promoted' : 're-queued'}.`)
      } else {
        const titleOf = (id: string) =>
          items.find((i) => i.id === id)?.title ??
          items.find((i) => i.id === id)?.externalId ??
          id
        setError(
          `${ok} ${action === 'promote' ? 'promoted' : 're-queued'}, ${failures.length} failed — ` +
            failures.map((f) => `${titleOf(f.id)}: ${f.reason}`).join(' · '),
        )
      }
    } finally {
      setBulkBusy(false)
    }
  }

  const workerStyle = health
    ? (WORKER_STYLE[health.worker.status] ?? {
        color: '#888',
        label: health.worker.status,
      })
    : null

  const selectionHasError = items.some(
    (i) => selected.has(i.id) && i.status === 'error',
  )

  return (
    <Box>
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Review queue & corpus health
      </Heading>

      {/* ── Instructions: what to do on this page ── */}
      <Text style={{ marginBottom: 16, color: '#555' }}>
        Documents flagged by the ingestion pipeline appear here for human
        review. A document lands here when its extraction confidence is low (the
        PDF didn&apos;t parse cleanly), when the ingestion job errored, or when
        the worker couldn&apos;t extract usable text. Review the document&apos;s
        metadata and suggested tags (click the document title), then either{' '}
        <strong>Promote</strong> (send it to the public search corpus) or{' '}
        <strong>Re-ingest</strong> (re-queue it for the worker to try again with
        the same file).
      </Text>

      {/* ── Corpus-health dashboard (design §11.317) ── */}
      {health && (
        <Box
          style={{
            marginBottom: 24,
            padding: 16,
            border: '1px solid #ddd',
            borderRadius: 6,
            background: '#fafafa',
          }}
        >
          <Heading size='sm' style={{ marginBottom: 12 }}>
            Corpus health
          </Heading>

          {/* Worker status */}
          <Box
            style={{
              marginBottom: 12,
              padding: 8,
              background: '#fff',
              borderRadius: 4,
              border: '1px solid #eee',
            }}
          >
            <Text style={{ fontWeight: 600 }}>
              Ingestion worker:{' '}
              <span style={{ color: workerStyle!.color }}>
                {workerStyle!.label}
              </span>
            </Text>
            <Text style={{ fontSize: 13, color: '#666' }}>
              Queue depth: {health.worker.queueDepth} · Intake backlog:{' '}
              {health.worker.intakeBacklog}
              {health.worker.lastProcessedAt &&
                ` · Last processed: ${new Date(health.worker.lastProcessedAt).toLocaleString()}`}
            </Text>
          </Box>

          {/* Counts grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {/* Status counts */}
            <Box
              style={{
                padding: 8,
                background: '#fff',
                borderRadius: 4,
                border: '1px solid #eee',
              }}
            >
              <Text style={{ fontWeight: 600, marginBottom: 4, fontSize: 13 }}>
                By status
              </Text>
              {Object.entries(health.statusCounts).map(([s, n]) => (
                <Text key={s} style={{ fontSize: 13, color: '#444' }}>
                  {s}: {n}
                </Text>
              ))}
            </Box>

            {/* Language counts */}
            <Box
              style={{
                padding: 8,
                background: '#fff',
                borderRadius: 4,
                border: '1px solid #eee',
              }}
            >
              <Text style={{ fontWeight: 600, marginBottom: 4, fontSize: 13 }}>
                By language
              </Text>
              {Object.entries(health.languageCounts).map(([l, n]) => (
                <Text key={l} style={{ fontSize: 13, color: '#444' }}>
                  {l}: {n}
                </Text>
              ))}
            </Box>

            {/* Review queue + gaps */}
            <Box
              style={{
                padding: 8,
                background: '#fff',
                borderRadius: 4,
                border: '1px solid #eee',
              }}
            >
              <Text style={{ fontWeight: 600, marginBottom: 4, fontSize: 13 }}>
                Review & gaps
              </Text>
              <Text style={{ fontSize: 13, color: '#444' }}>
                Review queue: {health.reviewQueueDepth}
              </Text>
              <Text
                style={{
                  fontSize: 13,
                  color:
                    health.docsMissingNativeSummary > 0 ? '#C11101' : '#444',
                }}
              >
                Missing native summary: {health.docsMissingNativeSummary}
              </Text>
              <Text
                style={{
                  fontSize: 13,
                  color: health.docsMissingTitleEn > 0 ? '#C11101' : '#444',
                }}
              >
                Missing English title: {health.docsMissingTitleEn}
              </Text>
              <Text
                style={{
                  fontSize: 13,
                  color: health.lowConfidenceDocs > 0 ? '#C11101' : '#444',
                }}
              >
                Low confidence (&lt;0.7): {health.lowConfidenceDocs}
              </Text>
            </Box>
          </div>

          {/* Multilingual-gap explainer */}
          {health.docsMissingNativeSummary > 0 && (
            <Text style={{ marginTop: 8, fontSize: 13, color: '#666' }}>
              {health.docsMissingNativeSummary} non-English document(s) have no
              summary in their own language (only English). A native-language
              summary helps same-language search find the document. Re-ingesting
              these documents regenerates the missing summaries.
            </Text>
          )}
        </Box>
      )}

      {notice && (
        <Text style={{ color: '#0A6640', marginBottom: 12 }}>{notice}</Text>
      )}
      {error && (
        <Text style={{ color: '#C11101', marginBottom: 12 }}>{error}</Text>
      )}

      {selected.size > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            marginBottom: 12,
            padding: '8px 12px',
            background: '#f0f8ff',
            borderRadius: 4,
          }}
        >
          <Text>{selected.size} selected</Text>
          <button
            onClick={() => bulkAct('promote')}
            disabled={bulkBusy || busyId !== null || selectionHasError}
            title={
              selectionHasError
                ? 'Selection includes a document with status "error" — those must be re-ingested before they can be promoted.'
                : 'Send the selected documents to the public search corpus.'
            }
            style={{ textDecoration: 'underline' }}
          >
            Promote {selected.size}
          </button>
          <button
            onClick={() => bulkAct('reingest')}
            disabled={bulkBusy || busyId !== null}
            title='Re-queue the selected documents for the ingestion pipeline.'
            style={{ textDecoration: 'underline' }}
          >
            Re-ingest {selected.size}
          </button>
        </div>
      )}

      {/* ── Review queue ── */}
      <Heading size='md' style={{ marginBottom: 8, display: 'inline-block' }}>
        Documents needing review
      </Heading>
      {items.length > 0 && (
        <Link
          href={`/admin/documents/${items[0].id}`}
          style={{ textDecoration: 'underline', fontSize: 14, marginLeft: 12 }}
          title='Open the first flagged document. A review bar on the editor walks you through the rest.'
        >
          Start reviewing ({items.length}) →
        </Link>
      )}
      {items.length === 0 ? (
        <Text style={{ color: '#555' }}>
          Queue is empty. 🎉 No documents are flagged for review. Check the
          corpus-health panel above for documents missing a summary in their own
          language — those need a re-ingest to regenerate, not a review action.
        </Text>
      ) : (
        <table
          style={{
            borderCollapse: 'collapse',
            width: '100%',
            marginBottom: 24,
          }}
        >
          <thead>
            <tr>
              <th style={{ ...cell, textAlign: 'left', background: '#f7f7f7' }}>
                <input
                  type='checkbox'
                  aria-label='Select all'
                  checked={selected.size === items.length && items.length > 0}
                  disabled={bulkBusy}
                  onChange={toggleAll}
                />
              </th>
              {[
                { key: 'document', node: 'Document' },
                { key: 'lang', node: 'Lang' },
                { key: 'status', node: 'Status' },
                {
                  key: 'confidence',
                  node: (
                    <Tooltip help='How cleanly the PDF text was extracted, from 0 to 1. Below 0.7 the document is held here for human review instead of going public automatically.'>
                      Confidence
                    </Tooltip>
                  ),
                },
                { key: 'why-flagged', node: 'Why flagged' },
                { key: 'suggested-tags', node: 'Suggested tags' },
                { key: 'actions', node: 'Actions' },
              ].map(({ key, node }) => (
                <th
                  key={key}
                  style={{ ...cell, textAlign: 'left', background: '#f7f7f7' }}
                >
                  {node}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td style={cell}>
                  <input
                    type='checkbox'
                    aria-label={`Select ${item.title || item.externalId}`}
                    checked={selected.has(item.id)}
                    disabled={bulkBusy}
                    onChange={() => toggleSelect(item.id)}
                  />
                </td>
                <td style={cell}>
                  <Link
                    href={`/admin/documents/${item.id}`}
                    style={{ textDecoration: 'underline' }}
                  >
                    {item.title || item.externalId}
                  </Link>
                </td>
                <td style={cell}>{item.language ?? '—'}</td>
                <td style={cell}>
                  <StatusChip status={item.status} />
                </td>
                <td style={cell}>
                  {item.extractionConfidence != null
                    ? item.extractionConfidence.toFixed(2)
                    : '—'}
                </td>
                <td style={cell}>
                  {item.jobError
                    ? `Job error: ${item.jobError.slice(0, 80)}${item.jobError.length > 80 ? '…' : ''} (${item.jobAttempts} attempt(s))`
                    : item.extractionConfidence != null &&
                        item.extractionConfidence < 0.7
                      ? `Low confidence (${item.extractionConfidence.toFixed(2)} < 0.7): the PDF may not have parsed cleanly`
                      : item.status === 'needs_review'
                        ? 'Flagged for review by the pipeline'
                        : '—'}
                </td>
                <td style={cell}>{item.suggestedTagCount}</td>
                <td style={cell}>
                  <button
                    disabled={busyId === item.id || bulkBusy}
                    onClick={() => act(item.id, 'promote')}
                    style={{ marginRight: 8, textDecoration: 'underline' }}
                    title='Send this document to the public search corpus'
                  >
                    Promote
                  </button>
                  <button
                    disabled={busyId === item.id || bulkBusy}
                    onClick={() => act(item.id, 'reingest')}
                    style={{ textDecoration: 'underline' }}
                    title='Re-queue this document for the ingestion worker to re-parse and re-process'
                  >
                    Re-ingest
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Text style={{ fontSize: 13, color: '#888' }}>
        <strong>Promote</strong> = send to the public search corpus (the
        document becomes searchable). <strong>Re-ingest</strong> = re-queue for
        the worker to re-parse the PDF and re-run the pipeline (use this if the
        extraction was poor and the file may now parse better).
      </Text>
    </Box>
  )
}

export default ReviewQueuePage
