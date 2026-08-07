'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Box, Heading, Text } from '@chakra-ui/react'

import { Tooltip } from '../components/Tooltip'
import { Flash } from '../components/Flash'
import { StatusChip } from '../components/StatusChip'
import { adminFetch } from '../lib/api'

interface WorkerHealth {
  queueDepth: number
  lastProcessedAt: string | null
  intakeBacklog: number
  status: 'idle' | 'processing' | 'pending' | 'stale'
}

// A file the user uploaded this session. In-memory only (gone on page leave,
// per the approved scope). Tracked until it reaches a terminal state.
// What the worker recorded this upload as a duplicate OF, when it can be
// resolved. The dedup decision lives in audit_log, not on any documents row —
// the rejected upload never gets one (worker/intake_s3.py:28-35).
interface DuplicateOf {
  externalId: string
  docId: string | null
  title: string | null
}

interface UploadEntry {
  filename: string
  stem: string
  uploadedAt: number
  docId: string | null
  docStatus: string | null // null until a documents row with external_id === stem appears
  likelyDuplicate: boolean
  // null = not looked up yet or no audit row found. A resolved value turns the
  // "likely duplicate" inference into a stated fact with a target.
  duplicateOf: DuplicateOf | null
}

const STATUS_STYLES: Record<
  WorkerHealth['status'],
  { color: string; label: string }
> = {
  idle: { color: '#0A6640', label: 'idle (caught up)' },
  processing: { color: '#0050C8', label: 'processing' },
  pending: { color: '#8a5a15', label: 'pending — worker will pick up shortly' },
  stale: {
    color: '#C11101',
    label: 'NOT RUNNING — dropped files are NOT being processed',
  },
}

// Mirrors MAX_FILE_BYTES in /api/admin/intake — reject oversized files before
// wasting an upload round-trip (and before the proxy body cap garbles them).
// 100MB: above Mistral OCR's own 50MB limit, which the parse stage covers by
// downsampling oversized PDFs with Ghostscript before submission (#310).
const MAX_FILE_BYTES = 100 * 1024 * 1024

const POLL_INTERVAL_MS = 5000
const DUPLICATE_TIMEOUT_MS = 90000
const TERMINAL_DOC_STATUSES = new Set([
  'searchable',
  'needs_review',
  'error',
  'withdrawn',
])

// Strip ONLY a trailing ".pdf" (case-insensitive) — matches Python Path().stem
// and workerHealth.ts:87, so names like "a.b.pdf" → "a.b".
const stemOf = (filename: string) => filename.replace(/\.pdf$/i, '')

const isPdf = (f: File) => f.name.toLowerCase().endsWith('.pdf')

const isTerminal = (e: UploadEntry) =>
  e.likelyDuplicate ||
  (e.docStatus != null && TERMINAL_DOC_STATUSES.has(e.docStatus))

// Unique per entry — stems can repeat across batches (same filename dropped
// twice in one session), so never key poll updates by stem alone.
const keyOf = (e: UploadEntry) => `${e.uploadedAt}-${e.filename}`

const UploadPage = () => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{
    done: number
    total: number
  } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [health, setHealth] = useState<WorkerHealth | null>(null)
  const [entries, setEntries] = useState<UploadEntry[]>([])

  // Read entries inside the interval without re-arming it on every change.
  // Written in an effect (not during render) to satisfy react-hooks/refs.
  const entriesRef = useRef<UploadEntry[]>([])
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

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
    // `skipMessage` carries a non-PDF skip warning from a mixed drop; it must
    // survive this function's error-state resets so the user sees BOTH the
    // skip warning and the upload result.
    async (files: File[], skipMessage?: string) => {
      if (files.length === 0) {
        setError('Select at least one PDF file.')
        return
      }
      setBusy(true)
      setNotice(null)
      setError(skipMessage ?? null)
      // One request per file: a bad or oversized file only fails itself, every
      // other file still lands, and each failure is reported by name. (The
      // route validates all-or-nothing per request, so batching would let one
      // bad file silently sink the rest — the issue #310 symptom.)
      let uploadedCount = 0
      const failures: string[] = []
      try {
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          setProgress({ done: i, total: files.length })
          if (f.size > MAX_FILE_BYTES) {
            failures.push(
              `${f.name}: file too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB)`,
            )
            continue
          }
          try {
            const form = new FormData()
            form.append('files', f)
            const res = await fetch('/api/admin/intake', {
              method: 'POST',
              body: form,
            })
            if (res.status === 401) {
              window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
              return
            }
            const body = await res.json().catch(() => ({}))
            if (!res.ok || body.ok === false) {
              failures.push(`${f.name}: ${body.error || `HTTP ${res.status}`}`)
              continue
            }
            const uploaded = (body.uploaded as string[]) ?? []
            uploadedCount += uploaded.length
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
                duplicateOf: null,
              })),
            ])
          } catch (err: any) {
            failures.push(`${f.name}: ${err?.message ?? String(err)}`)
          }
        }
        await loadHealth()
        const failMessage =
          failures.length > 0
            ? `${failures.length} file(s) failed. ${failures.join('; ')}`
            : null
        const errorParts = [skipMessage, failMessage].filter(Boolean)
        setError(errorParts.length > 0 ? errorParts.join(' — ') : null)
        if (uploadedCount > 0) {
          setNotice(
            `${uploadedCount} file(s) dropped into the intake queue. Track each one below.`,
          )
        }
      } finally {
        // Always clear the input — even after a failure — so re-picking the
        // same files fires a fresh change event (a same-value re-pick doesn't).
        if (inputRef.current) inputRef.current.value = ''
        setProgress(null)
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
    const skipMessage =
      rejected.length > 0
        ? `Skipped non-PDF file(s): ${rejected.map((f) => f.name).join(', ')}`
        : undefined
    if (pdfs.length > 0) {
      uploadFiles(pdfs, skipMessage)
    } else if (skipMessage) {
      setError(skipMessage)
    }
  }

  // Single shared interval for the whole list. Re-arms only when the set of
  // non-terminal entries opens/closes (via `activePolling`), reading current
  // entries through entriesRef so ticks always see fresh state.
  const activePolling = entries.some((e) => !isTerminal(e))
  useEffect(() => {
    if (!activePolling) return
    const tick = async () => {
      const pending = entriesRef.current.filter((e) => !isTerminal(e))
      if (pending.length === 0) return

      // Fetch the (global, coarse) intake backlog once per tick. NOTE: this
      // signal is 0 when other users have no queued files; it is ALSO always 0
      // in INTAKE_LOCAL_DIR mode (no S3 bucket), so the duplicate inference can
      // over-fire in local dev — that's a known local-only artifact.
      let backlog: number | null = null
      try {
        const res = await fetch('/api/admin/worker-health')
        if (res.ok) {
          const body = await res.json()
          if (body.ok) {
            backlog = body.health.intakeBacklog
            // Keep the worker-health panel live while polling — we already
            // paid for the fetch.
            setHealth(body.health)
          }
        }
      } catch {
        // best-effort; leave backlog null (never triggers the duplicate inference)
      }

      const updates = new Map<string, Partial<UploadEntry>>()
      await Promise.all(
        pending.map(async (e) => {
          try {
            const body = await adminFetch<{
              items: { id: string; externalId: string; status: string }[]
            }>(
              `/api/admin/documents?search=${encodeURIComponent(e.stem)}&limit=5`,
            )
            // `search` is an ILIKE substring match — exact-match the stem here.
            const match = body.items.find((it) => it.externalId === e.stem)
            if (match) {
              updates.set(keyOf(e), {
                docId: match.id,
                docStatus: match.status,
              })
              return
            }
          } catch {
            // poll failure: leave the entry at its last known state
            return
          }
          // Not registered. Infer a likely (content-hash) duplicate only after
          // the timeout AND when the worker reports an empty intake queue.
          if (
            backlog === 0 &&
            Date.now() - e.uploadedAt > DUPLICATE_TIMEOUT_MS
          ) {
            // Ask what it duplicated. The audit row names the match; resolving
            // it turns the inference into a fact the user can go look at. A
            // miss here is expected and non-fatal — the file may have failed
            // to register for some other reason — so the hedged label stays
            // as the fallback.
            let duplicateOf: DuplicateOf | null = null
            try {
              const dup = await adminFetch<{ duplicate: DuplicateOf | null }>(
                `/api/admin/intake/duplicate?filename=${encodeURIComponent(e.filename)}`,
              )
              duplicateOf = dup.duplicate
            } catch {
              // leave null; the label falls back to the inference wording
            }
            updates.set(keyOf(e), { likelyDuplicate: true, duplicateOf })
          }
        }),
      )

      if (updates.size > 0) {
        setEntries((prev) =>
          prev.map((e) => {
            const u = updates.get(keyOf(e))
            return u ? { ...e, ...u } : e
          }),
        )
      }
    }
    const id = setInterval(tick, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [activePolling])

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
        Select one or more PDF files (max 100MB each). Files over 50MB are
        handled automatically — the OCR service caps out at 50MB, so the worker
        downsamples the imagery and, if that is not enough, splits the document
        by pages. Very large image-heavy PDFs near the 100MB ceiling can still
        exceed the limit after both; those fail with a message naming the sizes
        in the{' '}
        <Link href='/admin/review' style={{ textDecoration: 'underline' }}>
          review queue
        </Link>
        , and the{' '}
        <Link href='/admin/guide' style={{ textDecoration: 'underline' }}>
          guide
        </Link>{' '}
        covers how to compress one. They will be placed in the intake queue and
        registered by the ingestion worker automatically.{' '}
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
        {busy
          ? progress && progress.total > 1
            ? `Uploading ${progress.done + 1} of ${progress.total}…`
            : 'Uploading…'
          : 'Drop PDFs here or click to choose'}
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
                key={keyOf(e)}
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
                {e.docStatus != null && e.docId != null ? (
                  <>
                    <StatusChip status={e.docStatus} />
                    <Link
                      href={`/admin/documents/${e.docId}`}
                      style={{ textDecoration: 'underline' }}
                    >
                      open →
                    </Link>
                  </>
                ) : e.likelyDuplicate && e.duplicateOf?.docId ? (
                  // Resolved: the worker recorded exactly what this duplicated.
                  // New tab so the user keeps this list — the uploads are
                  // in-memory only and navigating away loses them.
                  <>
                    <span style={{ color: '#8a5a15', fontWeight: 600 }}>
                      duplicate of
                    </span>
                    <a
                      href={`/admin/documents/${e.duplicateOf.docId}`}
                      target='_blank'
                      rel='noopener noreferrer'
                      style={{
                        textDecoration: 'underline',
                        maxWidth: 320,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={e.duplicateOf.title ?? e.duplicateOf.externalId}
                    >
                      {e.duplicateOf.title ?? e.duplicateOf.externalId} →
                    </a>
                  </>
                ) : e.likelyDuplicate ? (
                  <Tooltip
                    help={
                      e.duplicateOf
                        ? `The worker skipped this as a duplicate of "${e.duplicateOf.externalId}", but that document is no longer in the system — it was deleted after the dedup check. Nothing to open.`
                        : 'Not registered after 90s and the intake queue is empty — the worker most likely skipped this file as a content-hash duplicate. No dedup record was found for this filename, so it may instead have failed to register for another reason; check the review queue and the worker logs.'
                    }
                  >
                    <span style={{ color: '#8a5a15', fontWeight: 600 }}>
                      likely duplicate
                    </span>
                  </Tooltip>
                ) : (
                  <span style={{ color: '#666' }}>
                    uploaded — waiting to register…
                  </span>
                )}
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
