'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { Box, Heading, Text } from '@chakra-ui/react'
import { adminFetch } from '../lib/api'
import { actionButton } from '../lib/buttonStyles'
import { StatusChip } from '../components/StatusChip'
import { Flash } from '../components/Flash'

interface DocItem {
  id: string
  externalId: string
  title: string | null
  titleEn: string | null
  language: string | null
  status: string
  yearPublished: number | null
  createdAt: string
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

// created_at is also the implicit default order when no sort param is set
// (newest first), so the Uploaded column matches what an unsorted view shows.
const COLUMNS: { label: string; sortKey: string | null }[] = [
  { label: 'External ID', sortKey: null },
  { label: 'Title', sortKey: 'title' },
  { label: 'Language', sortKey: null },
  { label: 'Status', sortKey: 'status' },
  { label: 'Year', sortKey: 'year_published' },
  { label: 'Uploaded', sortKey: 'created_at' },
]

const CatalogInner = () => {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  // The URL is the single source of truth for the view. Everything below is derived.
  const filters = {
    status: searchParams.get('status') ?? '',
    language: searchParams.get('language') ?? '',
    collectionId: searchParams.get('collectionId') ?? '',
    search: searchParams.get('search') ?? '',
    yearPublished: searchParams.get('yearPublished') ?? '',
    tagId: searchParams.get('tagId') ?? '',
  }
  const sort = searchParams.get('sort') ?? ''
  const dir = (searchParams.get('dir') as 'asc' | 'desc' | '') ?? ''
  const page = Math.max(0, parseInt(searchParams.get('page') ?? '0', 10) || 0)

  const [items, setItems] = useState<DocItem[]>([])
  const [total, setTotal] = useState(0)
  const [collections, setCollections] = useState<Collection[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [availableYears, setAvailableYears] = useState<number[]>([])
  // Live text the user is typing (feedback-layer seam). The committed value is
  // filters.search (from the URL); the input must NOT bind to it directly, but
  // is seeded from it on mount and re-synced on external URL changes below.
  const [searchText, setSearchText] = useState(searchParams.get('search') ?? '')
  const [tagSearch, setTagSearch] = useState('')
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

  const load = useCallback(
    async (f: typeof filters, s: string, d: string, pageNum: number) => {
      const seq = ++reqSeq.current
      try {
        const params = new URLSearchParams()
        if (f.status) params.set('status', f.status)
        if (f.language) params.set('language', f.language)
        if (f.collectionId) params.set('collectionId', f.collectionId)
        if (f.search) params.set('search', f.search)
        if (f.yearPublished) params.set('yearPublished', f.yearPublished)
        if (f.tagId) params.set('tagId', f.tagId)
        if (s) params.set('sort', s)
        if (d) params.set('dir', d)
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
    },
    [],
  )

  // Load dropdown options once.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCollections()
    loadTags()
    loadYears()
  }, [loadCollections, loadTags, loadYears])

  // Single source of truth: whenever the URL query changes, reload the list.
  // Derives filters/sort/dir/page from searchParams above; no imperative load()
  // calls live anywhere else.
  useEffect(() => {
    // A pending search-debounce timer captured a stale URL snapshot; if it
    // fired ~300ms after this URL-driven reload it would overwrite the fresh
    // view with stale search params. Clear it on every URL change.
    if (searchDebounce.current) {
      clearTimeout(searchDebounce.current)
      searchDebounce.current = null
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(filters, sort, dir, page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, load])

  // Re-seed the live search text when the URL's committed search changes
  // underneath us (back/forward, shared link). The guard below is defensive
  // only: the URL-keyed load effect above always clears the debounce ref
  // before this effect runs, so the ref can't be set here in practice.
  useEffect(() => {
    if (searchDebounce.current) return
    setSearchText(filters.search)
  }, [filters.search])

  // One URL writer: every view change (filter/sort/page) goes through here.
  // Navigation clears the transient bulk selection, as before.
  const setQuery = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString())
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v)
        else next.delete(k)
      }
      setSelected(new Set())
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    },
    [searchParams, pathname, router],
  )

  // Changing any filter resets to page 0 (omit the param).
  const updateFilter = (key: keyof typeof filters, value: string) =>
    setQuery({ [key]: value, page: '' })

  const updateSearch = (value: string) => {
    setSearchText(value) // reflect keystrokes immediately in the input
    if (searchDebounce.current) clearTimeout(searchDebounce.current)
    searchDebounce.current = setTimeout(() => {
      searchDebounce.current = null
      setQuery({ search: value, page: '' })
    }, 300)
  }

  // Sort cycle: asc → desc → default (third click clears sort), page-reset.
  const toggleSort = (key: string) => {
    if (sort !== key) setQuery({ sort: key, dir: 'asc', page: '' })
    else if (dir === 'asc') setQuery({ sort: key, dir: 'desc', page: '' })
    else setQuery({ sort: '', dir: '', page: '' })
  }

  const goToPage = (pageNum: number) =>
    setQuery({ page: pageNum <= 0 ? '' : String(pageNum) })

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
          aria-label='Filter by status'
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
          aria-label='Filter by language'
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
          aria-label='Filter by year published'
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
          aria-label='Filter by collection'
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
          aria-label='Filter by tag'
        >
          <option value=''>All tags</option>
          {Object.entries(
            tags
              .filter((t) =>
                tagSearch.trim()
                  ? t.valueId
                      .toLowerCase()
                      .includes(tagSearch.trim().toLowerCase())
                  : true,
              )
              .reduce<Record<string, Tag[]>>((acc, t) => {
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
          value={tagSearch}
          onChange={(e) => setTagSearch(e.target.value)}
          placeholder='filter tags…'
          aria-label='Filter tags by name'
          style={{ width: 110, fontFamily: 'inherit', fontSize: 'inherit' }}
        />

        <input
          type='text'
          placeholder='Search title, author, DOI, URL…'
          value={searchText}
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
            className='admin-btn'
            style={actionButton}
          >
            Add {selected.size} doc{selected.size === 1 ? '' : 's'} to
            collection
          </button>
          <Text
            style={{ fontSize: 12, color: '#595959', marginLeft: 8 }}
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
              <th
                scope='col'
                style={{ ...cell, textAlign: 'left', background: '#f7f7f7' }}
              >
                <input
                  type='checkbox'
                  checked={selected.size === items.length && items.length > 0}
                  onChange={toggleAll}
                />
              </th>
              {COLUMNS.map(({ label, sortKey }) => {
                const active = sortKey && sort === sortKey
                const ariaSort = !active
                  ? undefined
                  : dir === 'asc'
                    ? 'ascending'
                    : 'descending'
                return (
                  <th
                    key={label}
                    scope='col'
                    aria-sort={ariaSort}
                    style={{
                      ...cell,
                      textAlign: 'left',
                      background: '#f7f7f7',
                    }}
                  >
                    {sortKey ? (
                      <button
                        onClick={() => toggleSort(sortKey)}
                        style={{
                          font: 'inherit',
                          fontWeight: 'inherit',
                          cursor: 'pointer',
                          background: 'none',
                          border: 'none',
                          padding: 0,
                        }}
                      >
                        {label}
                        {active ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </button>
                    ) : (
                      label
                    )}
                  </th>
                )
              })}
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
                    {/* English first: the catalog list is English-only. The
                        native title stays on the detail page's dual-title header. */}
                    {doc.titleEn || doc.title || doc.externalId}
                  </Link>
                </td>
                <td style={cell}>{doc.language ?? '—'}</td>
                <td style={cell}>
                  <StatusChip status={doc.status} />
                </td>
                <td style={cell}>{doc.yearPublished ?? '—'}</td>
                <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                  {doc.createdAt
                    ? new Date(doc.createdAt).toLocaleDateString()
                    : '—'}
                </td>
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
            className='admin-btn'
            style={{
              ...actionButton,
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
            className='admin-btn'
            style={{
              ...actionButton,
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
