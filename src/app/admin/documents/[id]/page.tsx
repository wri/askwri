'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Box, Heading, Text } from '@chakra-ui/react'
import { adminFetch } from '../../lib/api'

interface Detail {
  document: Record<string, any>
  summaries: { language: string; kind: string; text: string; source: string | null }[]
  tags: {
    tagId: string
    facet: string
    valueId: string
    source: string
    status: string
    confidence: number | null
  }[]
  collections: { id: string; name: string; slug: string }[]
  latestJob: { status: string; stage: string | null; error: string | null; attempts: number } | null
}

const EDITABLE: { key: string; label: string; type?: 'number' | 'date' | 'textarea' }[] = [
  { key: 'title', label: 'Title' },
  { key: 'titleEn', label: 'Title (EN)' },
  { key: 'doi', label: 'DOI' },
  { key: 'authors', label: 'Authors', type: 'textarea' },
  { key: 'url', label: 'URL' },
  { key: 'datePublished', label: 'Date published', type: 'date' },
  { key: 'language', label: 'Language (ISO 639-1)' },
  { key: 'yearPublished', label: 'Year published', type: 'number' },
  { key: 'publicationTitle', label: 'Publication' },
  { key: 'articleType', label: 'Article type' },
  { key: 'wriPrimaryOffice', label: 'WRI primary office' },
]

const cell: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #eee' }

const DocumentEditorPage = () => {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [form, setForm] = useState<Record<string, any>>({})
  const [summaryEdits, setSummaryEdits] = useState<Record<string, string>>({})
  const [allTags, setAllTags] = useState<{ id: string; facet: string; valueId: string }[]>([])
  const [allCollections, setAllCollections] = useState<{ id: string; name: string; slug: string }[]>([])
  const [me, setMe] = useState<{ role?: string }>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addTagId, setAddTagId] = useState<string>('')
  const [addCollectionId, setAddCollectionId] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const formDirty = useRef(false)

  const load = useCallback(
    async (opts: { resetForm?: boolean } = {}) => {
      const body = await adminFetch<Detail>(`/api/admin/documents/${id}`)
      setDetail(body)
      if (opts.resetForm || !formDirty.current) {
        setForm(Object.fromEntries(EDITABLE.map(({ key }) => [key, body.document[key] ?? ''])))
        formDirty.current = false
      }
      // Reset summary edits to the loaded values (only for keys not being edited)
      setSummaryEdits((prev) => {
        const next: Record<string, string> = {}
        for (const s of body.summaries) {
          const skey = `${s.language}::${s.kind}`
          next[skey] = prev[skey] ?? s.text
        }
        return next
      })
    },
    [id],
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load({ resetForm: true }).catch((err: any) => setError(err.message))
    adminFetch<{ tags: any[] }>('/api/admin/tags')
      .then((b) => setAllTags(b.tags))
      .catch((err: any) => setError(err.message))
    adminFetch<{ collections: any[] }>('/api/admin/collections')
      .then((b) => setAllCollections(b.collections))
      .catch((err: any) => setError(err.message))
    fetch('/api/admin/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => setMe(b?.identity ?? {}))
      .catch(() => setMe({}))
  }, [load])

  const saveMetadata = async () => {
    setBusy(true)
    try {
      setError(null)
      setNotice(null)
      const patch: Record<string, any> = {}
      for (const { key, type } of EDITABLE) {
        const raw = form[key]
        patch[key] = raw === '' ? null : type === 'number' ? Number(raw) : raw
      }
      const body = await adminFetch<{ updated: string[] }>(`/api/admin/documents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      setNotice(`Saved (${body.updated.length} field(s) changed).`)
      await load({ resetForm: true })
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const saveSummary = async (language: string, kind: string) => {
    const skey = `${language}::${kind}`
    const text = summaryEdits[skey]
    if (text == null) return
    setBusy(true)
    try {
      setError(null)
      setNotice(null)
      await adminFetch(`/api/admin/documents/${id}/summaries`, {
        method: 'PATCH',
        body: JSON.stringify({ language, kind, text }),
      })
      setNotice(`Summary ${language}/${kind} saved.`)
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const decideTag = async (tagId: string, decision: 'accepted' | 'rejected') => {
    setBusy(true)
    try {
      setError(null)
      await adminFetch(`/api/admin/documents/${id}/tags/${tagId}`, {
        method: 'PATCH',
        body: JSON.stringify({ decision }),
      })
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const addTag = async () => {
    if (!addTagId) return
    setBusy(true)
    try {
      setError(null)
      await adminFetch(`/api/admin/documents/${id}/tags`, {
        method: 'POST',
        body: JSON.stringify({ tagId: addTagId }),
      })
      setAddTagId('')
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const setStatus = async (status: 'searchable' | 'withdrawn') => {
    setBusy(true)
    try {
      setError(null)
      setNotice(null)
      await adminFetch(
        `/api/admin/documents/${id}/status`,
        {
          method: 'POST',
          body: JSON.stringify({ status }),
        },
      )
      setNotice(`Status set to ${status}.`)
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const reingest = async () => {
    setBusy(true)
    try {
      setError(null)
      setNotice(null)
      await adminFetch(`/api/admin/documents/${id}/reingest`, { method: 'POST' })
      setNotice('Re-queued for ingestion.')
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const deleteDoc = async () => {
    if (!doc) return
    const confirmed = window.confirm(
      `Permanently delete "${doc.title || doc.externalId}"? This removes the document, its chunks/summaries, and the S3 PDF. This cannot be undone.`,
    )
    if (!confirmed) return
    setBusy(true)
    try {
      setError(null)
      await adminFetch(`/api/admin/documents/${id}`, { method: 'DELETE' })
      router.push('/admin/documents')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const removeFromCollection = async (collectionId: string) => {
    setBusy(true)
    try {
      setError(null)
      await adminFetch(`/api/admin/collections/${collectionId}/documents`, {
        method: 'DELETE',
        body: JSON.stringify({ documentId: id }),
      })
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const addToCollection = async () => {
    if (!addCollectionId) return
    setBusy(true)
    try {
      setError(null)
      await adminFetch(`/api/admin/collections/${addCollectionId}/documents`, {
        method: 'POST',
        body: JSON.stringify({ documentIds: [id] }),
      })
      setAddCollectionId('')
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // Group tags by facet
  const tagsByFacet: Record<string, Detail['tags']> = {}
  if (detail) {
    for (const tag of detail.tags) {
      if (!tagsByFacet[tag.facet]) tagsByFacet[tag.facet] = []
      tagsByFacet[tag.facet].push(tag)
    }
  }

  // Tags already on the document
  const existingTagIds = new Set(detail?.tags.map((t) => t.tagId) ?? [])
  const availableTags = allTags.filter((t) => !existingTagIds.has(t.id))

  // Collections already on the document
  const existingCollectionIds = new Set(detail?.collections.map((c) => c.id) ?? [])
  const availableCollections = allCollections.filter((c) => !existingCollectionIds.has(c.id))

  const doc = detail?.document

  return (
    <Box style={{ paddingBottom: 48 }}>
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Document editor
      </Heading>
      {doc && (
        <Text style={{ marginBottom: 16, color: '#555' }}>
          {doc.title || doc.externalId}
        </Text>
      )}

      {notice && <Text style={{ color: '#0A6640', marginBottom: 12 }}>{notice}</Text>}
      {error && <Text style={{ color: '#C11101', marginBottom: 12 }}>{error}</Text>}

      {/* Metadata panel */}
      <section style={{ marginBottom: 32 }}>
        <Heading size='md' style={{ marginBottom: 12 }}>
          Metadata
        </Heading>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <tbody>
            {EDITABLE.map(({ key, label, type }) => (
              <tr key={key}>
                <td style={{ ...cell, width: 200, fontWeight: 500 }}>{label}</td>
                <td style={cell}>
                  {type === 'textarea' ? (
                    <textarea
                      value={form[key] ?? ''}
                      onChange={(e) => {
                        formDirty.current = true
                        setForm((f) => ({ ...f, [key]: e.target.value }))
                      }}
                      rows={3}
                      style={{ width: '100%', fontFamily: 'inherit', fontSize: 'inherit' }}
                    />
                  ) : (
                    <input
                      type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
                      value={form[key] ?? ''}
                      onChange={(e) => {
                        formDirty.current = true
                        setForm((f) => ({ ...f, [key]: e.target.value }))
                      }}
                      style={{ width: '100%', fontFamily: 'inherit', fontSize: 'inherit' }}
                    />
                  )}
                </td>
                <td style={{ ...cell, color: '#888', fontSize: 12, width: 200 }}>
                  {doc ? String(doc[key] ?? '—') : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          onClick={saveMetadata}
          disabled={busy}
          style={{ marginTop: 8, padding: '6px 16px', textDecoration: 'underline' }}
        >
          Save
        </button>
      </section>

      {/* Source metadata (read-only) — the CSV-original values, so editors can
          see the raw authors/URL/date that were migrated into source_metadata. */}
      {doc?.sourceMetadata && (
        <section style={{ marginBottom: 32 }}>
          <details>
            <summary style={{ cursor: 'pointer', fontWeight: 600, marginBottom: 8 }}>
              Source metadata (read-only)
            </summary>
            <pre
              style={{
                background: '#f7f7f7',
                padding: 12,
                borderRadius: 4,
                fontSize: 12,
                overflow: 'auto',
                maxHeight: 400,
              }}
            >
              {JSON.stringify(doc.sourceMetadata, null, 2)}
            </pre>
          </details>
        </section>
      )}

      {/* Tags panel */}
      <section style={{ marginBottom: 32 }}>
        <Heading size='md' style={{ marginBottom: 12 }}>
          Tags
        </Heading>
        {Object.keys(tagsByFacet).length === 0 && <Text>No tags.</Text>}
        {Object.entries(tagsByFacet).map(([facet, tags]) => (
          <div key={facet} style={{ marginBottom: 16 }}>
            <Text style={{ fontWeight: 600, marginBottom: 4 }}>{facet}</Text>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <tbody>
                {tags.map((tag) => (
                  <tr key={tag.tagId}>
                    <td style={cell}>{tag.valueId}</td>
                    <td style={cell}>
                      <span
                        style={{
                          background: '#eee',
                          borderRadius: 4,
                          padding: '2px 6px',
                          fontSize: 12,
                        }}
                      >
                        {tag.source}/{tag.status}
                        {tag.confidence != null ? ` (${tag.confidence.toFixed(2)})` : ''}
                      </span>
                    </td>
                    <td style={cell}>
                      {tag.status === 'suggested' && (
                        <>
                          <button
                            onClick={() => decideTag(tag.tagId, 'accepted')}
                            disabled={busy}
                            style={{ marginRight: 8, textDecoration: 'underline' }}
                          >
                            Accept
                          </button>
                          <button
                            onClick={() => decideTag(tag.tagId, 'rejected')}
                            disabled={busy}
                            style={{ textDecoration: 'underline' }}
                          >
                            Reject
                          </button>
                        </>
                      )}
                      {tag.status === 'rejected' && (
                        <button
                          onClick={() => decideTag(tag.tagId, 'accepted')}
                          disabled={busy}
                          style={{ textDecoration: 'underline' }}
                        >
                          Accept
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={addTagId}
            onChange={(e) => setAddTagId(e.target.value)}
            style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
          >
            <option value=''>— add tag —</option>
            {availableTags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.facet} / {t.valueId}
              </option>
            ))}
          </select>
          <button onClick={addTag} disabled={busy} style={{ textDecoration: 'underline' }}>
            Add
          </button>
        </div>
      </section>

      {/* Summaries panel — editable (was read-only). Editors can now fix
          truncated/garbage summaries directly. Each row is a textarea with a
          Save button; source='human' rows are protected server-side. */}
      <section style={{ marginBottom: 32 }}>
        <Heading size='md' style={{ marginBottom: 12 }}>
          Summaries
        </Heading>
        {(!detail || detail.summaries.length === 0) && <Text>No summaries.</Text>}
        {detail?.summaries.map((s, i) => {
          const skey = `${s.language}::${s.kind}`
          return (
            <div key={i} style={{ marginBottom: 16 }}>
              <Text style={{ fontWeight: 600, marginBottom: 4 }}>
                {s.language} · {s.kind} ({s.source ?? 'unknown'})
              </Text>
              <textarea
                data-summary-key={skey}
                value={summaryEdits[skey] ?? s.text}
                onChange={(e) =>
                  setSummaryEdits((prev) => ({ ...prev, [skey]: e.target.value }))
                }
                rows={4}
                style={{
                  width: '100%',
                  fontFamily: 'inherit',
                  fontSize: 'inherit',
                  background: '#f7f7f7',
                  padding: '8px 12px',
                  borderRadius: 4,
                }}
              />
              <button
                onClick={() => saveSummary(s.language, s.kind)}
                disabled={busy || summaryEdits[skey] === s.text}
                style={{ marginTop: 4, padding: '4px 12px', textDecoration: 'underline' }}
              >
                Save {s.language}/{s.kind}
              </button>
            </div>
          )
        })}
      </section>

      {/* Lifecycle panel */}
      <section style={{ marginBottom: 32 }}>
        <Heading size='md' style={{ marginBottom: 12 }}>
          Lifecycle
        </Heading>
        {doc && (
          <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 12 }}>
            <tbody>
              <tr>
                <td style={{ ...cell, width: 200, fontWeight: 500 }}>Status</td>
                <td style={cell}>{doc.status}</td>
              </tr>
              <tr>
                <td style={{ ...cell, fontWeight: 500 }}>Extraction confidence</td>
                <td style={cell}>
                  {doc.extractionConfidence != null
                    ? Number(doc.extractionConfidence).toFixed(2)
                    : '—'}
                </td>
              </tr>
              {detail?.latestJob && (
                <>
                  <tr>
                    <td style={{ ...cell, fontWeight: 500 }}>Latest job status</td>
                    <td style={cell}>
                      {detail.latestJob.status}
                      {detail.latestJob.stage ? ` / ${detail.latestJob.stage}` : ''}
                      {detail.latestJob.error
                        ? ` ⚠ (${detail.latestJob.attempts} attempts)`
                        : ''}
                    </td>
                  </tr>
                  {detail.latestJob.error && (
                    <tr>
                      <td style={{ ...cell, fontWeight: 500 }}>Job error</td>
                      <td style={{ ...cell, color: '#C11101' }}>{detail.latestJob.error}</td>
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {doc?.status !== 'searchable' && (
            <button
              onClick={() => setStatus('searchable')}
              disabled={busy}
              style={{ textDecoration: 'underline' }}
            >
              Promote
            </button>
          )}
          {me.role === 'admin' && (
            <button
              onClick={() => setStatus('withdrawn')}
              disabled={busy}
              style={{ textDecoration: 'underline' }}
            >
              Withdraw
            </button>
          )}
          <button onClick={reingest} disabled={busy} style={{ textDecoration: 'underline' }}>
            Re-ingest
          </button>
          <a
            href={`/api/admin/documents/${id}/file`}
            target='_blank'
            rel='noreferrer'
            style={{ textDecoration: 'underline' }}
          >
            Open PDF
          </a>
          {me.role === 'admin' && (
            <button
              onClick={deleteDoc}
              disabled={busy}
              style={{ textDecoration: 'underline', color: '#C11101' }}
            >
              Delete
            </button>
          )}
        </div>
      </section>

      {/* Collections panel */}
      <section style={{ marginBottom: 32 }}>
        <Heading size='md' style={{ marginBottom: 12 }}>
          Collections
        </Heading>
        {(!detail || detail.collections.length === 0) && <Text>Not in any collections.</Text>}
        {detail && detail.collections.length > 0 && (
          <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 8 }}>
            <tbody>
              {detail.collections.map((c) => (
                <tr key={c.id}>
                  <td style={cell}>{c.name}</td>
                  <td style={{ ...cell, color: '#888' }}>{c.slug}</td>
                  <td style={cell}>
                    <button
                      onClick={() => removeFromCollection(c.id)}
                      disabled={busy}
                      style={{ textDecoration: 'underline' }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={addCollectionId}
            onChange={(e) => setAddCollectionId(e.target.value)}
            style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
          >
            <option value=''>— add to collection —</option>
            {availableCollections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button onClick={addToCollection} disabled={busy} style={{ textDecoration: 'underline' }}>
            Add
          </button>
        </div>
      </section>
    </Box>
  )
}

export default DocumentEditorPage
