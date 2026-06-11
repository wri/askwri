'use client'

import { useRef, useState } from 'react'
import { Box, Heading, Text } from '@chakra-ui/react'

const WORKER_POLL_SECONDS = 10

const UploadPage = () => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
      setNotice(
        `${n} file(s) dropped into intake — the worker registers them within ~${WORKER_POLL_SECONDS}s (${WORKER_POLL_SECONDS}s default); duplicates are skipped by content hash.`,
      )
      if (inputRef.current) inputRef.current.value = ''
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box>
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Upload PDFs to intake
      </Heading>
      <Text style={{ marginBottom: 16, color: '#555' }}>
        Select one or more PDF files. They will be placed in the intake queue and registered by the
        worker automatically. Duplicates (by content hash) are skipped.
      </Text>
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
    </Box>
  )
}

export default UploadPage
