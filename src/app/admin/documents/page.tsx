'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Box, Heading, Text } from '@chakra-ui/react'
import { adminFetch } from '../lib/api'
import { StatusChip } from '../components/StatusChip'
import { Flash } from '../components/Flash'

interface DocItem {
  id: string
  externalId: string
  title: string | null
  language: string | null
  status: string
  yearPublished: number | null
}

interface Collection {
  id: string
  name: string
  slug: string
}

interface Tag {
  id: string
  facet: string
  valueId: string
}

const PAGE_SIZE = 50

const cell: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid #eee',
}

const CatalogInner = () => {
  const searchParams = useSearchParams()
  const initialCollectionId = searchParams.get('collectionId') ?? ''

  const [items, setItems] = useState<DocItem[]>([])
  const [total, setTotal] = useState(0)
  const [collections, setCollections] = useState<Collection[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [availableYears, setAvailableYears] = useState<number[]>([])
  const [page, setPage] = useState(0)
  const [filters, setFilters] = useState({
    status: '',
    language: '',
    collectionId: initialCollectionId,
    search: '',
    yearPublished: '',
    tagId: '',
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkCollectionId, setBulkCollectionId] = useState<string>('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const loadCollections = useCallback(async () => {
    try {
      const body = await adminFetch<{ collections: Collection[] }>(
        '/api/admin/collections',
      )
      setCollections(body.collections)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  const loadTags = useCallback(async () => {
    try {
      const body = await adminFetch<{ tags: Tag[] }>('/api/admin/tags')
      setTags(body.tags)
    } catch {
      // tags are best-effort; don't block the page
    }
  }, [])

  const loadYears = useCallback(async () => {
    try {
      // Derive distinct years from the first page (the corpus is small enough).
      // A dedicated endpoint would be cleaner, but this avoids a new API.
      const years = new Set<number>()
      // The list endpoint doesn't return all years without pagination; use a
      // lightweight query via the same endpoint with a high limit.
      const allBody = await adminFetch<{ items: DocItem[]; total: number }>(
        `/api/admin/documents?limit=500`,
      )
      for (const d of allBody.items) {
        if (d.yearPublished) years.add(d.yearPublished)
      }
      setAvailableYears(Array.from(years).sort((a, b) => b - a))
    } catch {
      // best-effort
    }
  }, [])

  const reqSeq = useRef(0)
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (f: typeof filters, pageNum: number) => {
    const seq = ++reqSeq.current
    try {
      const params = new URLSearchParams()
      if (f.status) params.set('status', f.status)
      if (f.language) params.set('language', f.language)
      if (f.collectionId) params.set('collectionId', f.collectionId)
      if (f.search) params.set('search', f.search)
      if (f.yearPublished) params.set('yearPublished', f.yearPublished)
      if (f.tagId) params.set('tagId', f.tagId)
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String(pageNum * PAGE_SIZE))
      const body = await adminFetch<{ items: DocItem[]; total: number }>(
        `/api/admin/documents?${params}`,
      )
      if (seq !== reqSeq.current) return
      setItems(body.items)
      setTotal(body.total)
      setError(null)
    } catch (err: any) {
      if (seq !== reqSeq.current) return
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCollections()
    loadTags()
    loadYears()
    const f = {
      status: '',
      language: '',
      collectionId: initialCollectionId,
      search: '',
      yearPublished: '',
      tagId: '',
    }
    setFilters(f)
    setPage(0)
    setSelected(new Set())
    load(f, 0)
  }, [load, loadCollections, loadTags, loadYears, initialCollectionId])

  const clearSearchDebounce = () => {
    if (searchDebounce.current) {
      clearTimeout(searchDebounce.current)
      searchDebounce.current = null
    }
  }

  const updateFilter = (key: keyof typeof filters, value: string) => {
    clearSearchDebounce()
    const next = { ...filters, [key]: value }
    setFilters(next)
    setPage(0)
    setSelected(new Set())
    load(next, 0)
  }

  const updateSearch = (value: string) => {
    const next = { ...filters, search: value }
    setFilters(next) // reflect keystrokes immediately in the input
    setPage(0)
    setSelected(new Set())
    clearSearchDebounce()
    searchDebounce.current = setTimeout(() => load(next, 0), 300)
  }

  const goToPage = (pageNum: number) => {
    clearSearchDebounce()
    setPage(pageNum)
    setSelected(new Set())
    load(filters, pageNum)
  }

  // Cancel any pending search timer on unmount.
  useEffect(
    () => () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current)
    },
    [],
  )

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (selected.size === items.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(items.map((d) => d.id)))
    }
  }

  const addToCollection = async () => {
    if (!bulkCollectionId || selected.size === 0) return
    setNotice(null)
    setError(null)
    try {
      await adminFetch(`/api/admin/collections/${bulkCollectionId}/documents`, {
        method: 'POST',
        body: JSON.stringify({ documentIds: Array.from(selected) }),
      })
      const col = collections.find((c) => c.id === bulkCollectionId)
      setNotice(
        `Added ${selected.size} document${selected.size === 1 ? '' : 's'} to ${col?.name ?? bulkCollectionId}.`,
      )
      setSelected(new Set())
      setBulkCollectionId('')
    } catch (err: any) {
      setError(err.message)
    }
  }

  return (
    <Box>
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Document catalog
      </Heading>

      <Flash
        notice={notice}
        error={error}
        onDismiss={() => {
          setNotice(null)
          setError(null)
        }}
      />

      {/* Filter bar */}
      <div
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}
      >
        <select
          value={filters.status}
          onChange={(e) => updateFilter('status', e.target.value)}
          style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
        >
          <option value=''>All statuses</option>
          {[
            'draft',
            'processing',
            'needs_review',
            'searchable',
            'withdrawn',
            'error',
          ].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          value={filters.language}
          onChange={(e) => updateFilter('language', e.target.value)}
          style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
        >
          <option value=''>All languages</option>
          {['en', 'es', 'zh', 'pt', 'id'].map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>

        <select
          value={filters.yearPublished}
          onChange={(e) => updateFilter('yearPublished', e.target.value)}
          style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
        >
          <option value=''>All years</option>
          {availableYears.map((y) => (
            <option key={y} value={String(y)}>
              {y}
            </option>
          ))}
        </select>

        <select
          value={filters.collectionId}
          onChange={(e) => updateFilter('collectionId', e.target.value)}
          style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
        >
          <option value=''>All collections</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <select
          value={filters.tagId}
          onChange={(e) => updateFilter('tagId', e.target.value)}
          style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
          title='Filter by taxonomy tag (facet value)'
        >
          <option value=''>All tags</option>
          {Object.entries(
            tags.reduce<Record<string, Tag[]>>((acc, t) => {
              ;(acc[t.facet] ??= []).push(t)
              return acc
            }, {}),
          )
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([facet, ts]) => (
              <optgroup key={facet} label={facet}>
                {ts.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.valueId}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>

        <input
          type='text'
          placeholder='Search title, author, DOI, URL…'
          value={filters.search}
          onChange={(e) => updateSearch(e.target.value)}
          style={{
            fontFamily: 'inherit',
            fontSize: 'inherit',
            padding: '2px 6px',
          }}
        />
      </div>

      {/* Bulk action bar */}
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
          <Text style={{ marginRight: 4 }}>{selected.size} selected</Text>
          <select
            value={bulkCollectionId}
            onChange={(e) => setBulkCollectionId(e.target.value)}
            style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
          >
            <option value=''>— choose collection —</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            onClick={addToCollection}
            disabled={!bulkCollectionId}
            style={{ textDecoration: 'underline' }}
          >
            Add {selected.size} doc{selected.size === 1 ? '' : 's'} to
            collection
          </button>
          <Text
            style={{ fontSize: 12, color: '#888', marginLeft: 8 }}
            title='Collections are curatorial groups of documents (e.g. a topic, a project, a language set). Adding documents to a collection groups them for filtering, bulk operations, and per-collection embedding-model policies. It does not change the document itself.'
          >
            ℹ What does this do?
          </Text>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <Text>Loading…</Text>
      ) : items.length === 0 ? (
        <Text>No documents found.</Text>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...cell, textAlign: 'left', background: '#f7f7f7' }}>
                <input
                  type='checkbox'
                  checked={selected.size === items.length && items.length > 0}
                  onChange={toggleAll}
                />
              </th>
              {['External ID', 'Title', 'Language', 'Status', 'Year'].map(
                (h) => (
                  <th
                    key={h}
                    style={{
                      ...cell,
                      textAlign: 'left',
                      background: '#f7f7f7',
                    }}
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((doc) => (
              <tr key={doc.id}>
                <td style={cell}>
                  <input
                    type='checkbox'
                    checked={selected.has(doc.id)}
                    onChange={() => toggleSelect(doc.id)}
                  />
                </td>
                <td style={cell}>{doc.externalId}</td>
                <td style={cell}>
                  <Link
                    href={`/admin/documents/${doc.id}`}
                    style={{ textDecoration: 'underline' }}
                  >
                    {doc.title || doc.externalId}
                  </Link>
                </td>
                <td style={cell}>{doc.language ?? '—'}</td>
                <td style={cell}>
                  <StatusChip status={doc.status} />
                </td>
                <td style={cell}>{doc.yearPublished ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Pagination */}
      {total > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            marginTop: 16,
            fontSize: 13,
            color: '#555',
          }}
        >
          <button
            onClick={() => goToPage(page - 1)}
            disabled={page === 0}
            style={{
              textDecoration: 'underline',
              cursor: page === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            ← Prev
          </button>
          <Text>
            Showing {page * PAGE_SIZE + 1}–
            {Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </Text>
          <button
            onClick={() => goToPage(page + 1)}
            disabled={(page + 1) * PAGE_SIZE >= total}
            style={{
              textDecoration: 'underline',
              cursor:
                (page + 1) * PAGE_SIZE >= total ? 'not-allowed' : 'pointer',
            }}
          >
            Next →
          </button>
        </div>
      )}
    </Box>
  )
}

const CatalogPage = () => (
  <Suspense>
    <CatalogInner />
  </Suspense>
)

export default CatalogPage
