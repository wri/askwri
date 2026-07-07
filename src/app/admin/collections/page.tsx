'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Box, Heading, Text } from '@chakra-ui/react'
import { adminFetch } from '../lib/api'
import { Tooltip } from '../components/Tooltip'

interface Collection {
  id: string
  name: string
  slug: string
  description: string | null
  documentCount: number
}

const cell: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #eee' }

const CollectionsPage = () => {
  const [items, setItems] = useState<Collection[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [renameBusy, setRenameBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const body = await adminFetch<{ collections: Collection[] }>('/api/admin/collections')
      setItems(body.collections)
      setError(null)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setNotice(null)
    setError(null)
    setCreateBusy(true)
    try {
      await adminFetch('/api/admin/collections', {
        method: 'POST',
        body: JSON.stringify({ name: createName, description: createDescription || null }),
      })
      setCreateName('')
      setCreateDescription('')
      setNotice('Collection created.')
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setCreateBusy(false)
    }
  }

  const startEdit = (col: Collection) => {
    setEditId(col.id)
    setEditName(col.name)
  }

  const saveRename = async (id: string) => {
    setNotice(null)
    setError(null)
    setRenameBusy(true)
    try {
      await adminFetch(`/api/admin/collections/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editName }),
      })
      setEditId(null)
      setNotice('Collection renamed.')
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setRenameBusy(false)
    }
  }

  return (
    <Box style={{ paddingBottom: 48 }}>
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Collections{' '}
        <Tooltip help='Collections are curated groups of documents (e.g. by topic, project, or language). They support bulk operations (re-tag, re-embed, export) and can carry a language policy and embedding-model version for staged migration.'>What are collections?</Tooltip>
      </Heading>
      <Text style={{ marginBottom: 16, color: '#555' }}>
        Collections group documents for management and bulk operations. A document can belong to multiple collections.
      </Text>

      {notice && <Text style={{ color: '#0A6640', marginBottom: 12 }}>{notice}</Text>}
      {error && <Text style={{ color: '#C11101', marginBottom: 12 }}>{error}</Text>}

      <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 24 }}>
        <thead>
          <tr>
            {['Name', 'Slug', 'Description', 'Documents', 'Actions'].map((h) => (
              <th key={h} style={{ ...cell, textAlign: 'left', background: '#f7f7f7' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((col) => (
            <tr key={col.id}>
              <td style={cell}>
                {editId === col.id ? (
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    style={{ fontFamily: 'inherit', fontSize: 'inherit', width: '100%' }}
                  />
                ) : (
                  col.name
                )}
              </td>
              <td style={{ ...cell, color: '#888' }}>{col.slug}</td>
              <td style={cell}>{col.description ?? '—'}</td>
              <td style={cell}>{col.documentCount}</td>
              <td style={cell}>
                {editId === col.id ? (
                  <>
                    <button
                      onClick={() => saveRename(col.id)}
                      disabled={renameBusy}
                      style={{ marginRight: 8, textDecoration: 'underline' }}
                    >
                      Save
                    </button>
                    <button onClick={() => setEditId(null)} style={{ textDecoration: 'underline' }}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => startEdit(col)}
                      style={{ marginRight: 8, textDecoration: 'underline' }}
                    >
                      Rename
                    </button>
                    <Link
                      href={`/admin/documents?collectionId=${col.id}`}
                      style={{ textDecoration: 'underline' }}
                    >
                      View documents
                    </Link>
                  </>
                )}
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={5} style={cell}>
                No collections yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Create form */}
      <Heading size='md' style={{ marginBottom: 12 }}>
        New collection
      </Heading>
      <form onSubmit={create} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <input
          placeholder='Name'
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          required
          style={{ fontFamily: 'inherit', fontSize: 'inherit', padding: '4px 8px' }}
        />
        <input
          placeholder='Description (optional)'
          value={createDescription}
          onChange={(e) => setCreateDescription(e.target.value)}
          style={{ fontFamily: 'inherit', fontSize: 'inherit', padding: '4px 8px', minWidth: 240 }}
        />
        <button
          type='submit'
          disabled={!createName || createBusy}
          style={{ textDecoration: 'underline' }}
        >
          Create
        </button>
      </form>
    </Box>
  )
}

export default CollectionsPage
