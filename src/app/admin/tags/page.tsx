'use client'

import { useCallback, useEffect, useState } from 'react'
import { Box, Heading, Text } from '@chakra-ui/react'
import { adminFetch } from '../lib/api'

interface Tag {
  id: string
  facet: string
  valueId: string
  taxonomyVersion: string | null
  acceptedCount: number
  suggestedCount: number
}

const cell: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #eee' }

const TagsPage = () => {
  const [tags, setTags] = useState<Tag[]>([])
  const [me, setMe] = useState<{ role?: string }>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addFacet, setAddFacet] = useState('')
  const [addNewFacet, setAddNewFacet] = useState('')
  const [addValue, setAddValue] = useState('')
  const [addBusy, setAddBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const body = await adminFetch<{ tags: Tag[] }>('/api/admin/tags')
      setTags(body.tags)
      setError(null)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    fetch('/api/admin/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => setMe(b?.identity ?? {}))
      .catch(() => setMe({}))
  }, [load])

  const deleteTag = async (id: string, valueId: string) => {
    if (!window.confirm(`Delete tag "${valueId}"? This cannot be undone.`)) return
    setNotice(null)
    setError(null)
    try {
      await adminFetch(`/api/admin/tags/${id}`, { method: 'DELETE' })
      setNotice(`Tag "${valueId}" deleted.`)
      await load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const addTag = async (e: React.FormEvent) => {
    e.preventDefault()
    setNotice(null)
    setError(null)
    const facet = addFacet === '__new__' ? addNewFacet.trim() : addFacet
    if (!facet || !addValue.trim()) return
    setAddBusy(true)
    try {
      await adminFetch('/api/admin/tags', {
        method: 'POST',
        body: JSON.stringify({ facet, valueId: addValue.trim() }),
      })
      setAddFacet('')
      setAddNewFacet('')
      setAddValue('')
      setNotice('Tag created.')
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setAddBusy(false)
    }
  }

  // Group by facet
  const byFacet: Record<string, Tag[]> = {}
  for (const tag of tags) {
    if (!byFacet[tag.facet]) byFacet[tag.facet] = []
    byFacet[tag.facet].push(tag)
  }

  const distinctFacets = Object.keys(byFacet).sort()

  return (
    <Box>
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Tags
      </Heading>
      <Text style={{ marginBottom: 16, color: '#555', fontStyle: 'italic' }}>
        Taxonomy v1 (raw CSV values). Rename/merge and version bumps are deferred until a curation
        owner is assigned — see docs/document-management.md §10.7.
      </Text>

      {notice && <Text style={{ color: '#0A6640', marginBottom: 12 }}>{notice}</Text>}
      {error && <Text style={{ color: '#C11101', marginBottom: 12 }}>{error}</Text>}

      {distinctFacets.map((facet) => (
        <section key={facet} style={{ marginBottom: 24 }}>
          <Heading size='md' style={{ marginBottom: 8 }}>
            {facet}
          </Heading>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                {['Value', 'Accepted', 'Suggested', 'Taxonomy version', ...(me.role === 'admin' ? [''] : [])].map((h) => (
                  <th key={h} style={{ ...cell, textAlign: 'left', background: '#f7f7f7' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {byFacet[facet].map((tag) => (
                <tr key={tag.id}>
                  <td style={cell}>{tag.valueId}</td>
                  <td style={cell}>{tag.acceptedCount}</td>
                  <td style={cell}>{tag.suggestedCount}</td>
                  <td style={cell}>{tag.taxonomyVersion ?? '—'}</td>
                  {me.role === 'admin' && (
                    <td style={cell}>
                      {tag.acceptedCount === 0 && tag.suggestedCount === 0 && (
                        <button
                          onClick={() => deleteTag(tag.id, tag.valueId)}
                          style={{ textDecoration: 'underline', color: '#C11101' }}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      {tags.length === 0 && <Text>No tags yet.</Text>}

      {/* Add form */}
      <Heading size='md' style={{ marginBottom: 12 }}>
        New tag
      </Heading>
      <form onSubmit={addTag} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <select
          value={addFacet}
          onChange={(e) => setAddFacet(e.target.value)}
          style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
          required
        >
          <option value=''>— facet —</option>
          {distinctFacets.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
          <option value='__new__'>New facet…</option>
        </select>
        {addFacet === '__new__' && (
          <input
            placeholder='Facet name'
            value={addNewFacet}
            onChange={(e) => setAddNewFacet(e.target.value)}
            required
            style={{ fontFamily: 'inherit', fontSize: 'inherit', padding: '2px 6px' }}
          />
        )}
        <input
          placeholder='Value'
          value={addValue}
          onChange={(e) => setAddValue(e.target.value)}
          required
          style={{ fontFamily: 'inherit', fontSize: 'inherit', padding: '2px 6px' }}
        />
        <button type='submit' disabled={addBusy} style={{ textDecoration: 'underline' }}>
          Add
        </button>
      </form>
    </Box>
  )
}

export default TagsPage
