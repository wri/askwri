'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Box, Heading, Text } from '@chakra-ui/react'
import { adminFetch } from '../lib/api'

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

const cell: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #eee' }

const CatalogInner = () => {
  const searchParams = useSearchParams()
  const initialCollectionId = searchParams.get('collectionId') ?? ''

  const [items, setItems] = useState<DocItem[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [filters, setFilters] = useState({
    status: '',
    language: '',
    collectionId: initialCollectionId,
    search: '',
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkCollectionId, setBulkCollectionId] = useState<string>('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadCollections = useCallback(async () => {
    try {
      const body = await adminFetch<{ collections: Collection[] }>('/api/admin/collections')
      setCollections(body.collections)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  const load = useCallback(async (f: typeof filters) => {
    try {
      const params = new URLSearchParams()
      if (f.status) params.set('status', f.status)
      if (f.language) params.set('language', f.language)
      if (f.collectionId) params.set('collectionId', f.collectionId)
      if (f.search) params.set('search', f.search)
      const body = await adminFetch<{ items: DocItem[] }>(`/api/admin/documents?${params}`)
      setItems(body.items)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCollections()
    load({ status: '', language: '', collectionId: initialCollectionId, search: '' })
  }, [load, loadCollections, initialCollectionId])

  const updateFilter = (key: keyof typeof filters, value: string) => {
    const next = { ...filters, [key]: value }
    setFilters(next)
    setSelected(new Set())
    load(next)
  }

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
      setNotice(`Added ${selected.size} document${selected.size === 1 ? '' : 's'} to ${col?.name ?? bulkCollectionId}.`)
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

      {notice && <Text style={{ color: '#0A6640', marginBottom: 12 }}>{notice}</Text>}
      {error && <Text style={{ color: '#C11101', marginBottom: 12 }}>{error}</Text>}

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <select
          value={filters.status}
          onChange={(e) => updateFilter('status', e.target.value)}
          style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
        >
          <option value=''>All statuses</option>
          {['draft', 'processing', 'needs_review', 'searchable', 'withdrawn', 'error'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select
          value={filters.language}
          onChange={(e) => updateFilter('language', e.target.value)}
          style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
        >
          <option value=''>All languages</option>
          {['en', 'es', 'zh', 'pt', 'id'].map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>

        <select
          value={filters.collectionId}
          onChange={(e) => updateFilter('collectionId', e.target.value)}
          style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
        >
          <option value=''>All collections</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <input
          type='text'
          placeholder='Search…'
          value={filters.search}
          onChange={(e) => updateFilter('search', e.target.value)}
          style={{ fontFamily: 'inherit', fontSize: 'inherit', padding: '2px 6px' }}
        />
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: '8px 12px', background: '#f0f8ff', borderRadius: 4 }}>
          <Text style={{ marginRight: 4 }}>{selected.size} selected</Text>
          <select
            value={bulkCollectionId}
            onChange={(e) => setBulkCollectionId(e.target.value)}
            style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
          >
            <option value=''>— choose collection —</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button
            onClick={addToCollection}
            disabled={!bulkCollectionId}
            style={{ textDecoration: 'underline' }}
          >
            Add {selected.size} doc{selected.size === 1 ? '' : 's'} to collection
          </button>
        </div>
      )}

      {/* Table */}
      {items.length === 0 ? (
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
              {['External ID', 'Title', 'Language', 'Status', 'Year'].map((h) => (
                <th key={h} style={{ ...cell, textAlign: 'left', background: '#f7f7f7' }}>
                  {h}
                </th>
              ))}
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
                  <Link href={`/admin/documents/${doc.id}`} style={{ textDecoration: 'underline' }}>
                    {doc.title || doc.externalId}
                  </Link>
                </td>
                <td style={cell}>{doc.language ?? '—'}</td>
                <td style={cell}>{doc.status}</td>
                <td style={cell}>{doc.yearPublished ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
