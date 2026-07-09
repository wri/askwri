'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Box, Heading, Text } from '@chakra-ui/react'

import { Tooltip } from '../components/Tooltip'
import { Flash } from '../components/Flash'

interface WorkerHealth {
  queueDepth: number
  lastProcessedAt: string | null
  intakeBacklog: number
  status: 'idle' | 'processing' | 'pending' | 'stale'
}

// A file the user uploaded this session. In-memory only (gone on page leave,
// per the approved scope). Tracked until it reaches a terminal state.
interface UploadEntry {
  filename: string
  stem: string
  uploadedAt: number
  docId: string | null
  docStatus: string | null // null until a documents row with external_id === stem appears
  likelyDuplicate: boolean
}

const STATUS_STYLES: Record<
  WorkerHealth['status'],
  { color: string; label: string }
> = {
  idle: { color: '#0A6640', label: 'idle (caught up)' },
  processing: { color: '#0050C8', label: 'processing' },
  pending: { color: '#B7791F', label: 'pending — worker will pick up shortly' },
  stale: {
    color: '#C11101',
    label: 'NOT RUNNING — dropped files are NOT being processed',
  },
}

// Strip ONLY a trailing ".pdf" (case-insensitive) — matches Python Path().stem
// and workerHealth.ts:87, so names like "a.b.pdf" → "a.b".
const stemOf = (filename: string) => filename.replace(/\.pdf$/i, '')

const isPdf = (f: File) => f.name.toLowerCase().endsWith('.pdf')

const UploadPage = () => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [health, setHealth] = useState<WorkerHealth | null>(null)
  const [entries, setEntries] = useState<UploadEntry[]>([])

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/worker-health')
      if (res.ok) {
        const body = await res.json()
        if (body.ok) setHealth(body.health)
      }
    } catch {
      // health is best-effort; don't block the page on it
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadHealth()
  }, [loadHealth])

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        setError('Select at least one PDF file.')
        return
      }
      setBusy(true)
      setNotice(null)
      setError(null)
      try {
        const form = new FormData()
        for (const f of files) form.append('files', f)
        const res = await fetch('/api/admin/intake', {
          method: 'POST',
          body: form,
        })
        if (res.status === 401) {
          window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
          return
        }
        const body = await res.json().catch(() => ({}))
        // Intake validation is ALL-OR-NOTHING: any bad file 400s the whole batch
        // with a single error string and no `uploaded` list. Surface the error
        // and leave the session list untouched — nothing was accepted.
        if (!res.ok || body.ok === false) {
          throw new Error(body.error || `HTTP ${res.status}`)
        }
        const uploaded = (body.uploaded as string[]) ?? []
        const now = Date.now()
        setEntries((prev) => [
          ...prev,
          ...uploaded.map((filename) => ({
            filename,
            stem: stemOf(filename),
            uploadedAt: now,
            docId: null,
            docStatus: null,
            likelyDuplicate: false,
          })),
        ])
        await loadHealth()
        if (inputRef.current) inputRef.current.value = ''
        setNotice(
          `${uploaded.length} file(s) dropped into the intake queue. Track each one below.`,
        )
      } catch (err: any) {
        setError(err.message)
      } finally {
        setBusy(false)
      }
    },
    [loadHealth],
  )

  const handlePick = () =>
    uploadFiles(Array.from(inputRef.current?.files ?? []))

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const all = Array.from(e.dataTransfer.files)
    const pdfs = all.filter(isPdf)
    const rejected = all.filter((f) => !isPdf(f))
    if (rejected.length > 0) {
      setError(
        `Skipped non-PDF file(s): ${rejected.map((f) => f.name).join(', ')}`,
      )
    }
    if (pdfs.length > 0) uploadFiles(pdfs)
  }

  // TASK 2: shared poll interval goes here.

  const statusStyle = health ? STATUS_STYLES[health.status] : null

  return (
    <Box>
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Upload PDFs to intake{' '}
        <Tooltip help='Uploaded PDFs are placed in the S3 intake/ queue. The ingestion worker (a separate process) polls every ~10s, computes a content hash for dedup, registers a draft documents row, and drives the file through parse → language → summarize → classify → embed → publish. If the worker is not running, files sit in intake/ unprocessed — check the worker status panel below.'>
          How does upload work?
        </Tooltip>
      </Heading>
      <Text style={{ marginBottom: 16, color: '#555' }}>
        Select one or more PDF files. They will be placed in the intake queue
        and registered by the ingestion worker automatically.{' '}
        <strong>
          If a file is identical to a document already in the system, it is
          silently skipped as a duplicate
        </strong>{' '}
        — it will not appear in the catalog a second time. To re-process an
        existing document, use <strong>Re-ingest</strong> on its document page
        instead of uploading the file again.
      </Text>

      {/* Worker health panel — unchanged */}
      <Box
        style={{
          marginBottom: 16,
          padding: 12,
          border: '1px solid #ddd',
          borderRadius: 4,
          background: '#f7f7f7',
        }}
      >
        <Text style={{ fontWeight: 600, marginBottom: 4 }}>
          Ingestion worker: {health ? statusStyle!.label : 'checking…'}
        </Text>
        {health && (
          <Text style={{ fontSize: 13, color: '#666' }}>
            <Tooltip help='Documents currently queued or being processed by the pipeline.'>
              Queue depth
            </Tooltip>
            : {health.queueDepth} ·{' '}
            <Tooltip help='Uploaded files the worker has not registered yet. A non-zero backlog right after an upload is normal.'>
              Intake backlog
            </Tooltip>
            : {health.intakeBacklog}
            {health.lastProcessedAt &&
              ` · Last processed: ${new Date(health.lastProcessedAt).toLocaleString()}`}
          </Text>
        )}
        {health?.status === 'stale' && (
          <Text style={{ fontSize: 13, color: '#C11101', marginTop: 4 }}>
            Files have been dropped into intake but the worker is not processing
            them. Contact an administrator to start the worker (`cd
            search-service && ./venv/bin/python -m worker.main` locally, or
            check the ECS `ingestion-worker` service in production).
          </Text>
        )}
      </Box>

      <Flash
        notice={notice}
        error={error}
        onDismiss={() => {
          setNotice(null)
          setError(null)
        }}
      />

      <div
        role='button'
        tabIndex={0}
        aria-label='Drop PDFs here or click to choose files'
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        style={{
          marginBottom: 12,
          padding: 32,
          border: `2px dashed ${dragOver ? '#0050C8' : '#bbb'}`,
          borderRadius: 6,
          background: dragOver ? '#eef4ff' : '#fafafa',
          textAlign: 'center',
          cursor: 'pointer',
          color: '#555',
        }}
      >
        {busy ? 'Uploading…' : 'Drop PDFs here or click to choose'}
        <input
          ref={inputRef}
          type='file'
          multiple
          accept='.pdf'
          aria-label='Choose PDF files'
          onChange={handlePick}
          style={{ display: 'none' }}
        />
      </div>

      {entries.length > 0 && (
        <Box style={{ marginTop: 24 }}>
          <Heading size='md' style={{ marginBottom: 8 }}>
            This session&rsquo;s uploads
          </Heading>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {entries.map((e) => (
              <li
                key={`${e.uploadedAt}-${e.filename}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 0',
                  borderBottom: '1px solid #eee',
                  fontSize: 14,
                }}
              >
                <span style={{ fontFamily: 'monospace', flex: 1 }}>
                  {e.filename}
                </span>
                {/* TASK 2: StatusChip + editor link / likely-duplicate branch. */}
                <span style={{ color: '#666' }}>
                  uploaded — waiting to register…
                </span>
              </li>
            ))}
          </ul>
        </Box>
      )}

      <Box style={{ marginTop: 16, fontSize: 13 }}>
        <Link href='/admin/review' style={{ textDecoration: 'underline' }}>
          Go to the Review queue →
        </Link>
      </Box>
    </Box>
  )
}

export default UploadPage
