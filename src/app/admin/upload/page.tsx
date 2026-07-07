'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Box, Heading, Text } from '@chakra-ui/react'

import { Tooltip } from '../components/Tooltip'

interface WorkerHealth {
  queueDepth: number
  lastProcessedAt: string | null
  intakeBacklog: number
  status: 'idle' | 'processing' | 'pending' | 'stale'
}

const STATUS_STYLES: Record<WorkerHealth['status'], { color: string; label: string }> = {
  idle: { color: '#0A6640', label: 'idle (caught up)' },
  processing: { color: '#0050C8', label: 'processing' },
  pending: { color: '#B7791F', label: 'pending — worker will pick up shortly' },
  stale: { color: '#C11101', label: 'NOT RUNNING — dropped files are NOT being processed' },
}

const UploadPage = () => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [health, setHealth] = useState<WorkerHealth | null>(null)

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

  const handleUpload = async () => {
    const files = inputRef.current?.files
    if (!files || files.length === 0) {
      setError('Select at least one PDF file.')
      return
    }
    setBusy(true)
    setNotice(null)
    setError(null)
    try {
      const form = new FormData()
      for (let i = 0; i < files.length; i++) {
        form.append('files', files[i])
      }
      const res = await fetch('/api/admin/intake', { method: 'POST', body: form })
      if (res.status === 401) {
        window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
        return
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) {
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const n = (body.uploaded as string[]).length
      // Refresh health immediately — the worker may have already picked them up
      // (it polls every ~10s), or the status may flip to "stale" if the worker
      // is down. Either way, show the real state instead of a fixed "10s" claim.
      await loadHealth()
      if (inputRef.current) inputRef.current.value = ''
      setNotice(
        `${n} file(s) dropped into the intake queue. ` +
          (health?.status === 'stale'
            ? '⚠ The ingestion worker is NOT running — your files will not be processed until it starts. See the worker status below.'
            : health?.status === 'pending'
              ? 'Files are in the intake queue — the worker will pick them up shortly. Track progress in the Review queue.'
              : 'The ingestion worker will register and process them shortly. Track progress in the Review queue.'),
      )
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const statusStyle = health ? STATUS_STYLES[health.status] : null

  return (
    <Box>
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Upload PDFs to intake{' '}
        <Tooltip help='Uploaded PDFs are placed in the S3 intake/ queue. The ingestion worker (a separate process) polls every ~10s, computes a content hash for dedup, registers a draft documents row, and drives the file through parse → language → summarize → classify → embed → publish. If the worker is not running, files sit in intake/ unprocessed — check the worker status panel below.'>How does upload work?</Tooltip>
      </Heading>
      <Text style={{ marginBottom: 16, color: '#555' }}>
        Select one or more PDF files. They will be placed in the intake queue and registered by the
        ingestion worker automatically. Duplicates (by content hash) are skipped.
      </Text>

      {/* Worker health panel — shows the real state instead of a misleading "~10s" claim */}
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
            Queue depth: {health.queueDepth} · Intake backlog: {health.intakeBacklog}
            {health.lastProcessedAt && ` · Last processed: ${new Date(health.lastProcessedAt).toLocaleString()}`}
          </Text>
        )}
        {health?.status === 'stale' && (
          <Text style={{ fontSize: 13, color: '#C11101', marginTop: 4 }}>
            Files have been dropped into intake but the worker is not processing them. Contact an
            administrator to start the worker (`cd search-service && ./venv/bin/python -m
            worker.main` locally, or check the ECS `ingestion-worker` service in production).
          </Text>
        )}
      </Box>

      {notice && <Text style={{ color: '#0A6640', marginBottom: 12 }}>{notice}</Text>}
      {error && <Text style={{ color: '#C11101', marginBottom: 12 }}>{error}</Text>}
      <div style={{ marginBottom: 12 }}>
        <input ref={inputRef} type='file' multiple accept='.pdf' />
      </div>
      <button
        disabled={busy}
        onClick={handleUpload}
        style={{ padding: '6px 16px', cursor: busy ? 'not-allowed' : 'pointer' }}
      >
        {busy ? 'Uploading…' : 'Upload'}
      </button>
      <Box style={{ marginTop: 16, fontSize: 13 }}>
        <Link href='/admin/review' style={{ textDecoration: 'underline' }}>
          Go to the Review queue →
        </Link>
      </Box>
    </Box>
  )
}

export default UploadPage
