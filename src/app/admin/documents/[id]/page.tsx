'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Box, Heading, Text } from '@chakra-ui/react'
import { adminFetch } from '../../lib/api'
import { actionButton, dangerButton } from '../../lib/buttonStyles'
import { PROVENANCE_BADGE } from '../../lib/provenance'
import { StatusChip } from '../../components/StatusChip'
import { Tooltip } from '../../components/Tooltip'
import { ReviewBar } from '../../components/ReviewBar'
import { Flash } from '../../components/Flash'
import { RelationsPanel } from '../../components/RelationsPanel'
import { PROVENANCE_KEY, PROVENANCE_LABEL } from '@/lib/metadataProvenance'

interface Detail {
  document: Record<string, any>
  summaries: {
    language: string
    kind: string
    text: string
    source: string | null
  }[]
  tags: {
    tagId: string
    facet: string
    valueId: string
    source: string
    status: string
    confidence: number | null
  }[]
  collections: { id: string; name: string; slug: string }[]
  latestJob: {
    status: string
    stage: string | null
    error: string | null
    attempts: number
  } | null
}

const LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'zh', name: 'Chinese' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'id', name: 'Indonesian' },
]

// Year published is a dropdown rather than a free number input (issue #304).
// A stored year outside the range still renders as its own option, so an older
// document is never silently rewritten by opening its editor.
const YEAR_MIN = 2000
const YEAR_MAX = 2027
const YEARS: number[] = Array.from(
  { length: YEAR_MAX - YEAR_MIN + 1 },
  (_, i) => YEAR_MAX - i,
)

// Columns whose dropdown options come from /api/admin/documents/field-values —
// the distinct values already in the corpus, since neither has a canonical
// vocabulary in the schema (issue #304).
type FieldValues = { articleType: string[]; wriPrimaryOffice: string[] }

const EDITABLE: {
  key: string
  label: string
  type?: 'number' | 'date' | 'textarea' | 'select' | 'year' | 'values'
  help: string
}[] = [
  {
    key: 'title',
    label: 'Title',
    help: 'The document title as shown in search results (in its original language).',
  },
  {
    key: 'titleEn',
    label: 'Title (EN)',
    help: 'English version of the title, shown to English-language users. Falls back to the native title if empty.',
  },
  {
    key: 'doi',
    label: 'DOI',
    help: 'Digital Object Identifier — the permanent link publishers assign (e.g. https://doi.org/10.46830/…). Also used to match rows in CSV imports.',
  },
  {
    key: 'authors',
    label: 'Authors',
    type: 'textarea',
    help: 'Author names, separated by semicolons (e.g. "Smith, John; Doe, Jane").',
  },
  {
    key: 'url',
    label: 'URL',
    help: 'The public landing page for this publication on wri.org.',
  },
  {
    key: 'datePublished',
    label: 'Date published',
    type: 'date',
    help: 'Full publication date, if known. Year alone goes in "Year published".',
  },
  {
    key: 'language',
    label: 'Language',
    type: 'select',
    help: 'The document’s primary language.',
  },
  {
    key: 'yearPublished',
    label: 'Year published',
    type: 'year',
    help: 'Publication year (used by the year filter in the catalog).',
  },
  {
    key: 'publicationTitle',
    label: 'Publication',
    help: 'The report or series this document belongs to.',
  },
  {
    key: 'articleType',
    label: 'Article type',
    type: 'values',
    help: 'The kind of publication (e.g. Report, Working Paper, Technical Note). Options are the types already in use across the corpus.',
  },
  {
    key: 'wriPrimaryOffice',
    label: 'WRI primary office',
    type: 'values',
    help: 'The WRI office or center primarily responsible (e.g. WRI India). Options are the offices already in use across the corpus.',
  },
]

const cell: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid #eee',
}

const tagChipText = (tag: Detail['tags'][number]) => {
  const source =
    tag.source === 'llm' ? 'AI' : tag.source === 'human' ? 'person' : 'imported'
  const conf =
    tag.confidence != null ? ` · ${Math.round(tag.confidence * 100)}%` : ''
  return `${source} · ${tag.status}${conf}`
}

const HISTORY_VERB: Record<string, string> = {
  update: 'updated',
  lifecycle: 'status',
  tag_decision: 'tag decision',
  collection_change: 'collections',
  import: 'import',
  create: 'created',
  delete: 'deleted',
}

const historyLine = (e: any) => {
  const verb = HISTORY_VERB[e.action] ?? e.action
  if (e.action === 'lifecycle')
    return `${e.actor} · status → ${e.after?.status ?? '?'}`
  const fields = e.after ? Object.keys(e.after).slice(0, 4).join(', ') : ''
  return `${e.actor} · ${verb}${fields ? ` ${fields}` : ''}`
}

const historyWhen = (at: string) => {
  const ms = Date.now() - +new Date(at)
  const h = Math.floor(ms / 3600000)
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h ago`
  if (h < 24 * 7) return `${Math.floor(h / 24)}d ago`
  return new Date(at).toLocaleDateString()
}

const DocumentEditorPage = () => {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [form, setForm] = useState<Record<string, any>>({})
  const [summaryEdits, setSummaryEdits] = useState<Record<string, string>>({})
  const [allTags, setAllTags] = useState<
    { id: string; facet: string; valueId: string }[]
  >([])
  const [allCollections, setAllCollections] = useState<
    { id: string; name: string; slug: string }[]
  >([])
  const [fieldValues, setFieldValues] = useState<FieldValues>({
    articleType: [],
    wriPrimaryOffice: [],
  })
  const [me, setMe] = useState<{ role?: string }>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addTagId, setAddTagId] = useState<string>('')
  const [addCollectionId, setAddCollectionId] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const formDirty = useRef(false)
  const [dirty, setDirty] = useState(false)
  const [history, setHistory] = useState<{
    total: number
    entries: any[]
  } | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const historyFetched = useRef(false)

  const loadHistory = useCallback(
    async (limit = 20) => {
      try {
        const body = await adminFetch<{ total: number; entries: any[] }>(
          `/api/admin/documents/${id}/history?limit=${limit}`,
        )
        setHistory({ total: body.total, entries: body.entries ?? [] })
      } catch (err: any) {
        setHistoryError(err.message)
      }
    },
    [id],
  )

  // The App Router keeps this page mounted across [id] changes (ReviewBar
  // navigation), so history state must reset per document. If the panel was
  // already opened, refetch — a bare null-reset would strand the still-open
  // <details> on "Loading…" forever.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistoryError(null)
    if (historyFetched.current) {
      setHistory(null) // clear stale rows → Loading…
      loadHistory() // closes over the new id
    }
  }, [loadHistory])

  const load = useCallback(
    async (opts: { resetForm?: boolean } = {}) => {
      const body = await adminFetch<Detail>(`/api/admin/documents/${id}`)
      setDetail(body)
      if (opts.resetForm || !formDirty.current) {
        setForm(
          Object.fromEntries(
            EDITABLE.map(({ key }) => [key, body.document[key] ?? '']),
          ),
        )
        formDirty.current = false
        setDirty(false)
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
    // Dropdown vocabularies. Failing to load them must not block editing, so
    // this one degrades to empty lists (the select still offers the row's own
    // value) rather than surfacing a page-level error.
    adminFetch<FieldValues>('/api/admin/documents/field-values')
      .then((b) =>
        setFieldValues({
          articleType: b.articleType ?? [],
          wriPrimaryOffice: b.wriPrimaryOffice ?? [],
        }),
      )
      .catch(() => {})
    fetch('/api/admin/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => setMe(b?.identity ?? {}))
      .catch(() => setMe({}))
  }, [load])

  // Warn on tab close/refresh while there are unsaved metadata edits.
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const saveMetadata = async () => {
    setBusy(true)
    try {
      setError(null)
      setNotice(null)
      const patch: Record<string, any> = {}
      for (const { key, type } of EDITABLE) {
        const raw = form[key]
        patch[key] =
          raw === ''
            ? null
            : type === 'number' || type === 'year'
              ? Number(raw)
              : raw
      }
      const body = await adminFetch<{ updated: string[] }>(
        `/api/admin/documents/${id}`,
        {
          method: 'PATCH',
          body: JSON.stringify(patch),
        },
      )
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

  const decideTag = async (
    tagId: string,
    decision: 'accepted' | 'rejected',
  ) => {
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

  const removeTag = async (tagId: string) => {
    setBusy(true)
    try {
      setError(null)
      await adminFetch(`/api/admin/documents/${id}/tags/${tagId}`, {
        method: 'DELETE',
      })
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // Repoint a tag row at a different value in the same facet (issue #304).
  // document_tags is keyed (document_id, tag_id) with no update path, so a
  // change is a remove + add; the new row lands as source='human'/'accepted'.
  // The add runs first: if it fails the document keeps its original tag rather
  // than losing it, which a delete-first order could not guarantee.
  const changeTag = async (oldTagId: string, newTagId: string) => {
    if (!newTagId || newTagId === oldTagId) return
    setBusy(true)
    try {
      setError(null)
      setNotice(null)
      await adminFetch(`/api/admin/documents/${id}/tags`, {
        method: 'POST',
        body: JSON.stringify({ tagId: newTagId }),
      })
      await adminFetch(`/api/admin/documents/${id}/tags/${oldTagId}`, {
        method: 'DELETE',
      })
      await load()
    } catch (err: any) {
      setError(err.message)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const setStatus = async (status: 'searchable' | 'withdrawn') => {
    setBusy(true)
    try {
      setError(null)
      setNotice(null)
      await adminFetch(`/api/admin/documents/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      })
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
      await adminFetch(`/api/admin/documents/${id}/reingest`, {
        method: 'POST',
      })
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
  const existingCollectionIds = new Set(
    detail?.collections.map((c) => c.id) ?? [],
  )
  const availableCollections = allCollections.filter(
    (c) => !existingCollectionIds.has(c.id),
  )

  // Options for the year / corpus-vocabulary dropdowns. The currently stored
  // value is prepended when the list does not already contain it, so a year
  // outside 2000-2027 or an article type no other document uses stays
  // selectable instead of silently reading as "—".
  const optionsFor = (
    type: 'year' | 'values',
    key: string,
    current: unknown,
  ): { value: string; label: string }[] => {
    const base =
      type === 'year'
        ? YEARS.map(String)
        : (fieldValues[key as keyof FieldValues] ?? [])
    const value = current == null || current === '' ? '' : String(current)
    const options = value && !base.includes(value) ? [value, ...base] : base
    return options.map((v) => ({ value: v, label: v }))
  }

  const doc = detail?.document

  return (
    <Box style={{ paddingBottom: 48 }}>
      <ReviewBar
        documentId={id}
        documentStatus={doc?.status}
        onChanged={() =>
          // Plain load(): the formDirty gate inside load() preserves unsaved
          // edits and resets the form otherwise.
          load().catch((err: any) => setError(err.message))
        }
      />
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Document editor
      </Heading>
      {/* Native title, with the English one beneath it (issue #304). For an
      English document the two are the same string, so title_en is shown only
      when it actually differs — repeating it would just read as a glitch. */}
      {doc && (
        <div style={{ marginBottom: 16 }}>
          <Text style={{ color: '#555' }} lang={doc.language ?? undefined}>
            {doc.title || doc.externalId}
          </Text>
          {doc.titleEn && doc.titleEn !== doc.title && (
            <Text style={{ color: '#595959', fontSize: 14 }} lang='en'>
              {doc.titleEn}
            </Text>
          )}
        </div>
      )}
      <Text style={{ marginBottom: 16, color: '#555' }}>
        Edit this document&apos;s metadata, summaries, tags, and lifecycle.
        Fields you save here are marked &ldquo;edited by a person&rdquo; and are
        never overwritten by CSV imports or by the AI when the document is
        re-ingested. Saving takes effect immediately.
      </Text>

      <Flash
        notice={notice}
        error={error}
        onDismiss={() => {
          setNotice(null)
          setError(null)
        }}
      />

      {!detail && !error ? (
        <Text>Loading…</Text>
      ) : (
        <>
          {/* Lifecycle panel */}
          <section style={{ marginBottom: 32 }}>
            <Heading size='md' style={{ marginBottom: 12 }}>
              Lifecycle
            </Heading>
            {doc && (
              <table
                style={{
                  borderCollapse: 'collapse',
                  width: '100%',
                  marginBottom: 12,
                }}
              >
                <tbody>
                  <tr>
                    <td style={{ ...cell, width: 200, fontWeight: 500 }}>
                      Status
                    </td>
                    <td style={cell}>
                      <StatusChip status={doc.status} />
                    </td>
                  </tr>
                  <tr>
                    <td style={{ ...cell, fontWeight: 500 }}>
                      Extraction confidence
                    </td>
                    <td style={cell}>
                      {doc.extractionConfidence != null
                        ? Number(doc.extractionConfidence).toFixed(2)
                        : '—'}
                    </td>
                  </tr>
                  {detail?.latestJob && (
                    <>
                      <tr>
                        <td style={{ ...cell, fontWeight: 500 }}>
                          Latest job status
                        </td>
                        <td style={cell}>
                          {detail.latestJob.status}
                          {detail.latestJob.stage
                            ? ` / ${detail.latestJob.stage}`
                            : ''}
                          {detail.latestJob.error
                            ? ` ⚠ (${detail.latestJob.attempts} attempts)`
                            : ''}
                        </td>
                      </tr>
                      {detail.latestJob.error && (
                        <tr>
                          <td style={{ ...cell, fontWeight: 500 }}>
                            Job error
                          </td>
                          <td style={{ ...cell, color: '#C11101' }}>
                            {detail.latestJob.error}
                          </td>
                        </tr>
                      )}
                    </>
                  )}
                </tbody>
              </table>
            )}
            <div
              style={{
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              {doc?.status === 'needs_review' && (
                <button
                  onClick={() => setStatus('searchable')}
                  disabled={busy}
                  title='Send this document to the public search corpus. Only reviewed documents can be promoted.'
                  className='admin-btn'
                  style={actionButton}
                >
                  Promote
                </button>
              )}
              {doc?.status === 'withdrawn' && me.role === 'admin' && (
                <button
                  onClick={() => setStatus('searchable')}
                  disabled={busy}
                  title='Put this withdrawn document back in the public search corpus.'
                  className='admin-btn'
                  style={actionButton}
                >
                  Restore
                </button>
              )}
              {me.role === 'admin' && doc?.status !== 'withdrawn' && (
                <button
                  onClick={() => {
                    if (
                      window.confirm(
                        'Withdraw this document? It disappears from public search immediately. An admin can restore it later.',
                      )
                    ) {
                      setStatus('withdrawn')
                    }
                  }}
                  disabled={busy}
                  title='Remove this document from public search immediately (reversible — admins can restore).'
                  className='admin-btn'
                  style={actionButton}
                >
                  Withdraw
                </button>
              )}
              <button
                onClick={reingest}
                disabled={busy}
                title='Re-run the ingestion pipeline on the same PDF. AI summaries and AI-extracted metadata are regenerated; fields and summaries edited by a person are preserved.'
                className='admin-btn'
                style={actionButton}
              >
                Re-ingest
              </button>
              <a
                href={`/api/admin/documents/${id}/file`}
                target='_blank'
                rel='noreferrer'
                title='Open the stored PDF in a new tab.'
                style={{ textDecoration: 'underline' }}
              >
                Open PDF
              </a>
              {me.role === 'admin' && (
                <button
                  onClick={deleteDoc}
                  disabled={busy}
                  title='Permanently delete this document, its search index entries, and its PDF. Cannot be undone.'
                  className='admin-btn'
                  style={dangerButton}
                >
                  Delete
                </button>
              )}
            </div>
          </section>

          {/* Metadata panel */}
          <section style={{ marginBottom: 32 }}>
            <Heading size='md' style={{ marginBottom: 12 }}>
              Metadata
            </Heading>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <tbody>
                {EDITABLE.map(({ key, label, type, help }) => (
                  <tr key={key}>
                    <td style={{ ...cell, width: 200, fontWeight: 500 }}>
                      <Tooltip help={help}>{label}</Tooltip>
                    </td>
                    <td style={cell}>
                      {type === 'select' ? (
                        <select
                          aria-label={label}
                          value={form[key] ?? ''}
                          onChange={(e) => {
                            formDirty.current = true
                            setDirty(true)
                            setForm((f) => ({ ...f, [key]: e.target.value }))
                          }}
                          style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
                        >
                          <option value=''>—</option>
                          {form[key] &&
                            !LANGUAGES.some((l) => l.code === form[key]) && (
                              <option value={form[key]}>
                                {form[key]} (unsupported)
                              </option>
                            )}
                          {LANGUAGES.map((l) => (
                            <option key={l.code} value={l.code}>
                              {l.name} ({l.code})
                            </option>
                          ))}
                        </select>
                      ) : type === 'year' || type === 'values' ? (
                        <select
                          aria-label={label}
                          value={form[key] ?? ''}
                          onChange={(e) => {
                            formDirty.current = true
                            setDirty(true)
                            setForm((f) => ({ ...f, [key]: e.target.value }))
                          }}
                          style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
                        >
                          <option value=''>—</option>
                          {/* The stored value always stays selectable, even when
                          it is outside the year range or absent from the corpus
                          vocabulary — opening an editor must never silently
                          rewrite a field. */}
                          {optionsFor(type, key, form[key]).map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      ) : type === 'textarea' ? (
                        <textarea
                          value={form[key] ?? ''}
                          onChange={(e) => {
                            formDirty.current = true
                            setDirty(true)
                            setForm((f) => ({ ...f, [key]: e.target.value }))
                          }}
                          rows={3}
                          style={{
                            width: '100%',
                            fontFamily: 'inherit',
                            fontSize: 'inherit',
                          }}
                        />
                      ) : (
                        <input
                          type={
                            type === 'number'
                              ? 'number'
                              : type === 'date'
                                ? 'date'
                                : 'text'
                          }
                          value={form[key] ?? ''}
                          onChange={(e) => {
                            formDirty.current = true
                            setDirty(true)
                            setForm((f) => ({ ...f, [key]: e.target.value }))
                          }}
                          style={{
                            width: '100%',
                            fontFamily: 'inherit',
                            fontSize: 'inherit',
                          }}
                        />
                      )}
                    </td>
                    <td style={{ ...cell, width: 90 }}>
                      {(() => {
                        const src =
                          doc?.metadataSource?.[PROVENANCE_KEY[key] ?? key]
                        const badge = src ? PROVENANCE_BADGE[src] : null
                        return badge ? (
                          <span
                            title={PROVENANCE_LABEL[src] ?? src}
                            style={{
                              background: badge.bg,
                              color: badge.color,
                              borderRadius: 4,
                              padding: '2px 6px',
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: 'help',
                            }}
                          >
                            {badge.text}
                          </span>
                        ) : null
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              onClick={saveMetadata}
              disabled={busy}
              className='admin-btn'
              style={{ ...actionButton, marginTop: 8, padding: '6px 16px' }}
            >
              {dirty ? 'Save (unsaved changes)' : 'Save'}
            </button>
          </section>

          {/* Tags panel */}
          <section style={{ marginBottom: 32 }}>
            <Heading size='md' style={{ marginBottom: 12 }}>
              Tags
            </Heading>
            {Object.keys(tagsByFacet).length === 0 && <Text>No tags.</Text>}
            {Object.entries(tagsByFacet).map(([facet, tags]) => (
              <div key={facet} style={{ marginBottom: 16 }}>
                <Text style={{ fontWeight: 600, marginBottom: 4 }}>
                  {facet}
                </Text>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <tbody>
                    {tags.map((tag) => (
                      <tr key={tag.tagId}>
                        <td style={cell}>
                          {/* Editable in place: the options are the other tags
                          in this same facet, so a row can be corrected without
                          remove-then-re-add. Facet stays fixed — it is the
                          heading this row sits under. */}
                          <select
                            aria-label={`${tag.facet} tag`}
                            value={tag.tagId}
                            disabled={busy}
                            onChange={(e) =>
                              changeTag(tag.tagId, e.target.value)
                            }
                            style={{
                              fontFamily: 'inherit',
                              fontSize: 'inherit',
                            }}
                          >
                            <option value={tag.tagId}>{tag.valueId}</option>
                            {allTags
                              .filter(
                                (t) =>
                                  t.facet === tag.facet &&
                                  t.id !== tag.tagId &&
                                  !existingTagIds.has(t.id),
                              )
                              .map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.valueId}
                                </option>
                              ))}
                          </select>
                        </td>
                        <td style={cell}>
                          <span
                            title='Who applied this tag and its review state. AI-suggested tags need a person to Accept or Reject them; accepting makes the tag permanent (the AI will never change it again).'
                            style={{
                              background: '#eee',
                              borderRadius: 4,
                              padding: '2px 6px',
                              fontSize: 12,
                              cursor: 'help',
                            }}
                          >
                            {tagChipText(tag)}
                          </span>
                        </td>
                        <td style={cell}>
                          {tag.status === 'suggested' && (
                            <>
                              <button
                                onClick={() => decideTag(tag.tagId, 'accepted')}
                                disabled={busy}
                                title='Keep this tag. It becomes a human decision the AI cannot override.'
                                className='admin-btn'
                                style={{ ...actionButton, marginRight: 8 }}
                              >
                                Accept
                              </button>
                              <button
                                onClick={() => decideTag(tag.tagId, 'rejected')}
                                disabled={busy}
                                title='Remove this suggestion. The AI will not re-suggest it.'
                                className='admin-btn'
                                style={actionButton}
                              >
                                Reject
                              </button>
                            </>
                          )}
                          {tag.status === 'rejected' && (
                            <button
                              onClick={() => decideTag(tag.tagId, 'accepted')}
                              disabled={busy}
                              title='Keep this tag. It becomes a human decision the AI cannot override.'
                              className='admin-btn'
                              style={actionButton}
                            >
                              Accept
                            </button>
                          )}
                          <button
                            onClick={() => removeTag(tag.tagId)}
                            disabled={busy}
                            title='Take this tag off the document entirely. Unlike Reject, it leaves no record on the document — the AI may suggest it again on re-ingest.'
                            className='admin-btn'
                            style={{ ...actionButton, marginLeft: 8 }}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <div
              style={{
                marginTop: 8,
                display: 'flex',
                gap: 8,
                alignItems: 'center',
              }}
            >
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
              <button
                onClick={addTag}
                disabled={busy}
                className='admin-btn'
                style={actionButton}
              >
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
            <Text style={{ marginBottom: 12, color: '#555', fontSize: 13 }}>
              Each document carries a long and a short summary, in its own
              language and in English. &ldquo;generated&rdquo; summaries were
              written by the AI and are refreshed on re-ingest; once you save an
              edit, the summary is yours and the AI never overwrites it.
            </Text>
            {(!detail || detail.summaries.length === 0) && (
              <Text>No summaries.</Text>
            )}
            {detail?.summaries.map((s, i) => {
              const skey = `${s.language}::${s.kind}`
              const sourceLabel =
                s.source === 'generated'
                  ? 'AI'
                  : s.source === 'external'
                    ? 'imported'
                    : s.source === 'human'
                      ? 'person'
                      : (s.source ?? 'unknown')
              return (
                <div key={i} style={{ marginBottom: 16 }}>
                  <Text style={{ fontWeight: 600, marginBottom: 4 }}>
                    {s.language} · {s.kind} ({sourceLabel})
                  </Text>
                  <textarea
                    data-summary-key={skey}
                    value={summaryEdits[skey] ?? s.text}
                    onChange={(e) =>
                      setSummaryEdits((prev) => ({
                        ...prev,
                        [skey]: e.target.value,
                      }))
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
                    className='admin-btn'
                    style={{
                      ...actionButton,
                      marginTop: 4,
                      padding: '4px 12px',
                    }}
                  >
                    Save {s.language}/{s.kind}
                  </button>
                </div>
              )
            })}
          </section>

          {/* Source metadata (read-only) — the CSV-original values, so editors can
          see the raw authors/URL/date that were migrated into source_metadata. */}
          {doc?.sourceMetadata && (
            <section style={{ marginBottom: 32 }}>
              <details>
                <summary
                  style={{
                    cursor: 'pointer',
                    fontWeight: 600,
                    marginBottom: 8,
                  }}
                >
                  Original imported metadata (read-only)
                </summary>
                <Text style={{ marginBottom: 8, color: '#555', fontSize: 13 }}>
                  These are the values that came with the document when it was
                  first imported — kept for reference, never edited.
                </Text>
                <table
                  style={{
                    borderCollapse: 'collapse',
                    width: '100%',
                    fontSize: 13,
                  }}
                >
                  <tbody>
                    {Object.entries(doc.sourceMetadata).map(([k, v]) => (
                      <tr key={k}>
                        <td
                          style={{
                            ...cell,
                            width: 220,
                            fontWeight: 500,
                            verticalAlign: 'top',
                          }}
                        >
                          {k}
                        </td>
                        <td style={cell}>
                          {typeof v === 'string' ? v : JSON.stringify(v)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </section>
          )}

          {/* Collections panel */}
          <section style={{ marginBottom: 32 }}>
            <Heading size='md' style={{ marginBottom: 12 }}>
              Collections
            </Heading>
            {(!detail || detail.collections.length === 0) && (
              <Text>Not in any collections.</Text>
            )}
            {detail && detail.collections.length > 0 && (
              <table
                style={{
                  borderCollapse: 'collapse',
                  width: '100%',
                  marginBottom: 8,
                }}
              >
                <tbody>
                  {detail.collections.map((c) => (
                    <tr key={c.id}>
                      <td style={cell}>{c.name}</td>
                      <td style={{ ...cell, color: '#595959' }}>{c.slug}</td>
                      <td style={cell}>
                        <button
                          onClick={() => removeFromCollection(c.id)}
                          disabled={busy}
                          className='admin-btn'
                          style={actionButton}
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
              <button
                onClick={addToCollection}
                disabled={busy}
                className='admin-btn'
                style={actionButton}
              >
                Add
              </button>
            </div>
          </section>

          {/* History panel — lazy: fetches on first expand */}
          <section style={{ marginBottom: 32 }}>
            <details
              onToggle={(e) => {
                if (
                  (e.target as HTMLDetailsElement).open &&
                  !historyFetched.current
                ) {
                  historyFetched.current = true
                  loadHistory()
                }
              }}
            >
              <summary
                style={{ cursor: 'pointer', fontWeight: 600, fontSize: 18 }}
              >
                History
              </summary>
              <Text style={{ margin: '8px 0', color: '#555', fontSize: 13 }}>
                Every recorded change to this document — who, what, and when.
                Automated pipeline steps are not recorded; imports and intake
                events are.
              </Text>
              {historyError && (
                <Text style={{ color: '#C11101' }}>{historyError}</Text>
              )}
              {!history && !historyError && (
                <Text style={{ color: '#595959', fontSize: 13 }}>Loading…</Text>
              )}
              {history && history.entries.length === 0 && (
                <Text style={{ color: '#555' }}>No recorded changes.</Text>
              )}
              {history &&
                history.entries.map((e, i) => (
                  <details
                    key={i}
                    style={{
                      padding: '6px 0',
                      borderBottom: '1px solid #eee',
                      fontSize: 13,
                    }}
                  >
                    <summary style={{ cursor: 'pointer' }}>
                      {historyLine(e)} ·{' '}
                      <span style={{ color: '#595959' }}>
                        {historyWhen(e.at)}
                      </span>
                    </summary>
                    <table
                      style={{
                        borderCollapse: 'collapse',
                        margin: '6px 0 6px 16px',
                        fontSize: 12,
                      }}
                    >
                      <tbody>
                        {Array.from(
                          new Set([
                            ...Object.keys(e.before ?? {}),
                            ...Object.keys(e.after ?? {}),
                          ]),
                        ).map((k) => (
                          <tr key={k}>
                            <td
                              style={{
                                padding: '2px 8px',
                                fontWeight: 500,
                                verticalAlign: 'top',
                              }}
                            >
                              {k}
                            </td>
                            <td
                              style={{
                                padding: '2px 8px',
                                color: '#C11101',
                                verticalAlign: 'top',
                                maxWidth: 480,
                                overflow: 'auto',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                              }}
                            >
                              {e.before?.[k] == null
                                ? '—'
                                : typeof e.before[k] === 'string'
                                  ? e.before[k]
                                  : JSON.stringify(e.before[k])}
                            </td>
                            <td
                              style={{
                                padding: '2px 8px',
                                color: '#0A6640',
                                verticalAlign: 'top',
                                maxWidth: 480,
                                overflow: 'auto',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                              }}
                            >
                              {e.after?.[k] == null
                                ? '—'
                                : typeof e.after[k] === 'string'
                                  ? e.after[k]
                                  : JSON.stringify(e.after[k])}
                            </td>
                          </tr>
                        ))}
                        {!e.before && !e.after && (
                          <tr>
                            <td
                              style={{ padding: '2px 8px', color: '#595959' }}
                            >
                              no field detail recorded
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </details>
                ))}
              {history && history.total > history.entries.length && (
                <button
                  onClick={() => loadHistory(Math.min(history.total, 500))}
                  className='admin-btn'
                  style={{ ...actionButton, marginTop: 8, fontSize: 13 }}
                >
                  {history.total > 500
                    ? `Show latest 500 of ${history.total}`
                    : `Show all (${history.total})`}
                </button>
              )}
            </details>
          </section>

          {/* Translation pairs (issue #325) */}
          <section style={{ marginBottom: 32 }}>
            <Heading size='md' style={{ marginBottom: 12 }}>
              Translation pairs
            </Heading>
            <RelationsPanel docId={id} />
          </section>
        </>
      )}
    </Box>
  )
}

export default DocumentEditorPage
