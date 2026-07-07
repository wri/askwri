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

/** The canonical taxonomy v1 facets (from the Phase-0 migration script's FACETS). */
const CANONICAL_FACETS = ['program', 'office', 'topic', 'doc_type']

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

  // Rename state (admin-only)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameFacet, setRenameFacet] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)

  const isAdmin = me.role === 'admin'

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

  const startRename = (tag: Tag) => {
    setRenameId(tag.id)
    setRenameValue(tag.valueId)
    setRenameFacet(tag.facet)
  }

  const saveRename = async (id: string) => {
    setNotice(null)
    setError(null)
    setRenameBusy(true)
    try {
      const patch: Record<string, string> = {}
      if (renameFacet.trim()) patch.facet = renameFacet.trim()
      if (renameValue.trim()) patch.valueId = renameValue.trim()
      await adminFetch(`/api/admin/tags/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      setRenameId(null)
      setNotice('Tag renamed.')
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setRenameBusy(false)
    }
  }

  // Group by facet
  const byFacet: Record<string, Tag[]> = {}
  for (const tag of tags) {
    if (!byFacet[tag.facet]) byFacet[tag.facet] = []
    byFacet[tag.facet].push(tag)
  }

  const distinctFacets = Object.keys(byFacet).sort()

  // Build the facet dropdown: all canonical facets first, then any existing
  // non-canonical facets, then "Create new facet…".
  const dropdownFacets = [
    ...CANONICAL_FACETS,
    ...distinctFacets.filter((f) => !CANONICAL_FACETS.includes(f)),
  ]

  return (
    <Box style={{ paddingBottom: 48 }}>
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Tags
      </Heading>
      <Text style={{ marginBottom: 8, color: '#555', fontStyle: 'italic' }}>
        Taxonomy v1 — the controlled vocabulary of facets and values used to classify documents.
        Facets are the categories (e.g. program, office, topic, doc_type); values are the entries
        within each facet. Tags are language-neutral: a Chinese and an English paper on the same
        topic carry the same tag (design §8).
      </Text>
      <Text style={{ marginBottom: 16, color: '#888', fontStyle: 'italic', fontSize: 13 }}>
        Note: taxonomy v1 values are the raw CSV strings. Rename is available to admins; merge and
        version bumps are deferred until a curation owner is assigned (design §10.7).
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
                {[
                  'Value',
                  'Facet',
                  'Accepted',
                  'Suggested',
                  'Taxonomy version',
                  ...(isAdmin ? [''] : []),
                ].map((h, i) => (
                  <th key={i} style={{ ...cell, textAlign: 'left', background: '#f7f7f7' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {byFacet[facet].map((tag) => (
                <tr key={tag.id}>
                  <td style={cell}>
                    {renameId === tag.id && isAdmin ? (
                      <input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        style={{ fontFamily: 'inherit', fontSize: 'inherit', width: '100%' }}
                      />
                    ) : (
                      tag.valueId
                    )}
                  </td>
                  <td style={cell}>
                    {renameId === tag.id && isAdmin ? (
                      <input
                        value={renameFacet}
                        onChange={(e) => setRenameFacet(e.target.value)}
                        style={{ fontFamily: 'inherit', fontSize: 'inherit', width: '100%' }}
                      />
                    ) : (
                      tag.facet
                    )}
                  </td>
                  <td style={cell}>{tag.acceptedCount}</td>
                  <td style={cell}>{tag.suggestedCount}</td>
                  <td style={cell}>{tag.taxonomyVersion ?? '—'}</td>
                  {isAdmin && (
                    <td style={cell}>
                      {renameId === tag.id ? (
                        <>
                          <button
                            onClick={() => saveRename(tag.id)}
                            disabled={renameBusy}
                            style={{ marginRight: 8, textDecoration: 'underline' }}
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setRenameId(null)}
                            style={{ textDecoration: 'underline' }}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => startRename(tag)}
                            style={{ marginRight: 8, textDecoration: 'underline' }}
                            title='Rename this tag value or facet (admin only)'
                          >
                            Rename
                          </button>
                          {tag.acceptedCount === 0 && tag.suggestedCount === 0 && (
                            <button
                              onClick={() => deleteTag(tag.id, tag.valueId)}
                              style={{ textDecoration: 'underline', color: '#C11101' }}
                            >
                              Delete
                            </button>
                          )}
                        </>
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
      <form
        onSubmit={addTag}
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}
      >
        <select
          value={addFacet}
          onChange={(e) => setAddFacet(e.target.value)}
          style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
          required
          aria-label='Facet'
        >
          <option value=''>— facet —</option>
          {dropdownFacets.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
          <option value='__new__'>Create new facet…</option>
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
