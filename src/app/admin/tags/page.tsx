'use client'

import { useCallback, useEffect, useState } from 'react'
import { Box, Heading, Text } from '@chakra-ui/react'
import { adminFetch } from '../lib/api'
import { actionButton, dangerButton } from '../lib/buttonStyles'
import { Flash } from '../components/Flash'
import { TopicTaxonomyManager } from '../topics/components/TopicTaxonomyManager'
import { useRouter, useSearchParams } from 'next/navigation'
import { Fragment, Suspense } from 'react'

interface Tag {
  id: string
  facet: string
  valueId: string
  taxonomyVersion: string | null
  acceptedCount: number
  suggestedCount: number
  parentTagId: string | null
}

/** The canonical taxonomy v1 facets (from the Phase-0 migration script's FACETS). */
const CANONICAL_FACETS = ['program', 'office', 'topic', 'doc_type', 'geography']
const FACET_LABELS: Record<string, string> = {
  program: 'Program',
  office: 'Office',
  topic: 'Topic',
  doc_type: 'Doc type',
  geography: 'Geography',
}

const facetLabel = (facet: string) =>
  FACET_LABELS[facet] ?? facet.charAt(0).toUpperCase() + facet.slice(1)

const cell: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid #eee',
}

/** Simple per-facet table with add/delete/rename (the legacy UI for non-topic facets). */
const FacetTable = ({
  facet,
  tags,
  isAdmin,
  onNotice,
  onError,
  onReload,
}: {
  facet: string
  tags: Tag[]
  isAdmin: boolean
  onNotice: (s: string) => void
  onError: (s: string) => void
  onReload: () => Promise<void>
}) => {
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameFacet, setRenameFacet] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)

  const deleteTag = async (id: string, valueId: string) => {
    if (!window.confirm(`Delete tag "${valueId}"? This cannot be undone.`))
      return
    onNotice('')
    onError('')
    try {
      await adminFetch(`/api/admin/tags/${id}`, { method: 'DELETE' })
      onNotice(`Tag "${valueId}" deleted.`)
      await onReload()
    } catch (err: any) {
      onError(err.message)
    }
  }

  const saveRename = async (id: string) => {
    onNotice('')
    onError('')
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
      onNotice('Tag renamed.')
      await onReload()
    } catch (err: any) {
      onError(err.message)
    } finally {
      setRenameBusy(false)
    }
  }

  return (
    <section style={{ marginBottom: 24 }}>
      <Heading size='md' style={{ marginBottom: 8 }}>
        {facetLabel(facet)}
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
              <th
                key={i}
                scope='col'
                style={{
                  ...cell,
                  textAlign: 'left',
                  background: '#f7f7f7',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tags.map((tag) => (
            <tr key={tag.id}>
              <td style={cell}>
                {renameId === tag.id && isAdmin ? (
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    style={{
                      fontFamily: 'inherit',
                      fontSize: 'inherit',
                      width: '100%',
                    }}
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
                    style={{
                      fontFamily: 'inherit',
                      fontSize: 'inherit',
                      width: '100%',
                    }}
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
                        className='admin-btn'
                        style={{ ...actionButton, marginRight: 8 }}
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setRenameId(null)}
                        className='admin-btn'
                        style={actionButton}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => {
                          setRenameId(tag.id)
                          setRenameValue(tag.valueId)
                          setRenameFacet(tag.facet)
                        }}
                        className='admin-btn'
                        style={{ ...actionButton, marginRight: 8 }}
                        title='Rename this tag value or facet (admin only)'
                      >
                        Rename
                      </button>
                      {tag.acceptedCount === 0 && tag.suggestedCount === 0 && (
                        <button
                          onClick={() => deleteTag(tag.id, tag.valueId)}
                          className='admin-btn'
                          style={dangerButton}
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
  )
}

/** Geography facet: countries grouped under their continent (parent tag),
 * collapsible. Mirrors FacetTable's row shape but nests children. Only used for
 * the geography facet, which has a continent→country tree via parent_tag_id. */
const GeographyTable = ({
  tags,
  isAdmin,
  onNotice,
  onError,
  onReload,
}: {
  tags: Tag[]
  isAdmin: boolean
  onNotice: (s: string) => void
  onError: (s: string) => void
  onReload: () => Promise<void>
}) => {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)

  const continents = tags
    .filter((t) => !t.parentTagId)
    .sort((a, b) => a.valueId.localeCompare(b.valueId))
  const childrenOf = (parentId: string) =>
    tags
      .filter((t) => t.parentTagId === parentId)
      .sort((a, b) => a.valueId.localeCompare(b.valueId))

  const deleteTag = async (id: string, valueId: string) => {
    if (!window.confirm(`Delete tag "${valueId}"? This cannot be undone.`))
      return
    onNotice('')
    onError('')
    try {
      await adminFetch(`/api/admin/tags/${id}`, { method: 'DELETE' })
      onNotice(`Tag "${valueId}" deleted.`)
      await onReload()
    } catch (err: any) {
      onError(err.message)
    }
  }

  const saveRename = async (id: string) => {
    onNotice('')
    onError('')
    setRenameBusy(true)
    try {
      await adminFetch(`/api/admin/tags/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ valueId: renameValue.trim() }),
      })
      setRenameId(null)
      onNotice('Tag renamed.')
      await onReload()
    } catch (err: any) {
      onError(err.message)
    } finally {
      setRenameBusy(false)
    }
  }

  const row = (tag: Tag, depth: number) => (
    <tr key={tag.id}>
      <td style={{ ...cell, paddingLeft: 12 + depth * 24 }}>
        {renameId === tag.id && isAdmin ? (
          <input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            style={{
              fontFamily: 'inherit',
              fontSize: 'inherit',
              width: '100%',
            }}
          />
        ) : (
          tag.valueId
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
                className='admin-btn'
                style={{ ...actionButton, marginRight: 8 }}
              >
                Save
              </button>
              <button
                onClick={() => setRenameId(null)}
                className='admin-btn'
                style={actionButton}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  setRenameId(tag.id)
                  setRenameValue(tag.valueId)
                }}
                className='admin-btn'
                style={{ ...actionButton, marginRight: 8 }}
                title='Rename this tag value (admin only)'
              >
                Rename
              </button>
              {tag.acceptedCount === 0 && tag.suggestedCount === 0 && (
                <button
                  onClick={() => deleteTag(tag.id, tag.valueId)}
                  className='admin-btn'
                  style={dangerButton}
                >
                  Delete
                </button>
              )}
            </>
          )}
        </td>
      )}
    </tr>
  )

  return (
    <section style={{ marginBottom: 24 }}>
      <Heading size='md' style={{ marginBottom: 8 }}>
        Geography
      </Heading>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            {[
              'Value',
              'Accepted',
              'Suggested',
              'Taxonomy version',
              ...(isAdmin ? [''] : []),
            ].map((h, i) => (
              <th
                key={i}
                scope='col'
                style={{ ...cell, textAlign: 'left', background: '#f7f7f7' }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {continents.map((continent) => {
            const kids = childrenOf(continent.id)
            const isOpen = open[continent.id] ?? true
            return (
              <Fragment key={continent.id}>
                <tr>
                  <td style={{ ...cell, fontWeight: 700 }}>
                    <button
                      onClick={() =>
                        setOpen((o) => ({
                          ...o,
                          [continent.id]: !o[continent.id],
                        }))
                      }
                      className='admin-btn'
                      style={{
                        ...actionButton,
                        marginRight: 6,
                        padding: '0 6px',
                      }}
                      title={isOpen ? 'Collapse' : 'Expand'}
                    >
                      {isOpen ? '▼' : '▶'}
                    </button>
                    {continent.valueId}
                    <span
                      style={{ color: '#888', fontWeight: 400, marginLeft: 8 }}
                    >
                      ({kids.length}{' '}
                      {kids.length === 1 ? 'country' : 'countries'})
                    </span>
                  </td>
                  <td style={cell}>{continent.acceptedCount}</td>
                  <td style={cell}>{continent.suggestedCount}</td>
                  <td style={cell}>{continent.taxonomyVersion ?? '—'}</td>
                  {isAdmin && <td style={cell} />}
                </tr>
                {isOpen && kids.map((kid) => row(kid, 1))}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

const TagsPage = () => {
  const [tags, setTags] = useState<Tag[]>([])
  const [me, setMe] = useState<{ role?: string }>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addFacet, setAddFacet] = useState('')
  const [addNewFacet, setAddNewFacet] = useState('')
  const [addValue, setAddValue] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const router = useRouter()
  const searchParams = useSearchParams()
  const activeFacet = searchParams.get('facet') || 'topic'

  const isAdmin = me.role === 'admin'

  const load = useCallback(async () => {
    try {
      const body = await adminFetch<{ tags: Tag[] }>('/api/admin/tags')
      setTags(body.tags)
      setError(null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
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

  const setFacet = (facet: string) => {
    router.push(`/admin/tags?facet=${facet}`)
  }

  const addTag = async (e: React.FormEvent) => {
    e.preventDefault()
    setNotice(null)
    setError(null)
    const facet = addFacet === '__new__' ? addNewFacet.trim() : addFacet
    if (!facet || !addValue.trim()) return
    const isNewFacet = addFacet === '__new__'
    setAddBusy(true)
    try {
      await adminFetch('/api/admin/tags', {
        method: 'POST',
        body: JSON.stringify({
          facet,
          valueId: addValue.trim(),
          allowNewFacet: isNewFacet,
        }),
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

  // Build the facet dropdown: all canonical facets first, then any existing
  // non-canonical facets, then "Create new facet…".
  const dropdownFacets = [
    ...CANONICAL_FACETS,
    ...distinctFacets.filter((f) => !CANONICAL_FACETS.includes(f)),
  ]

  const tabStyle = (facet: string): React.CSSProperties => ({
    padding: '6px 14px',
    border: '1px solid #e2e8f0',
    borderBottom:
      activeFacet === facet ? '2px solid #1a365d' : '1px solid #e2e8f0',
    background: activeFacet === facet ? '#fff' : '#f7f7f7',
    color: activeFacet === facet ? '#1a365d' : '#595959',
    fontWeight: activeFacet === facet ? 700 : 400,
    cursor: 'pointer',
    borderRadius: '6px 6px 0 0',
    fontSize: 13,
  })

  return (
    <Box style={{ paddingBottom: 48 }}>
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Tags
      </Heading>
      <Text style={{ marginBottom: 8, color: '#555', fontStyle: 'italic' }}>
        Taxonomy v1 — the controlled vocabulary of facets and values used to
        classify documents. Facets are the categories (e.g. program, office,
        topic, doc_type); values are the entries within each facet. Tags are
        language-neutral: a Chinese and an English paper on the same topic carry
        the same tag.
      </Text>
      <Text
        style={{
          marginBottom: 16,
          color: '#595959',
          fontStyle: 'italic',
          fontSize: 13,
        }}
      >
        Note: tag values are currently the raw imported strings. Admins can
        rename them; merging duplicate values is planned but not built yet.
      </Text>

      <Flash
        notice={notice}
        error={error}
        onDismiss={() => {
          setNotice(null)
          setError(null)
        }}
      />

      {/* Facet tab strip */}
      <Box
        style={{
          display: 'flex',
          gap: 4,
          marginBottom: 0,
          borderBottom: '1px solid #e2e8f0',
        }}
      >
        {CANONICAL_FACETS.map((facet) => (
          <Box
            key={facet}
            as='button'
            onClick={() => setFacet(facet)}
            style={tabStyle(facet)}
            _hover={undefined}
          >
            {facetLabel(facet)}
          </Box>
        ))}
      </Box>

      {/* Tab content */}
      <Box style={{ paddingTop: 16 }}>
        {activeFacet === 'topic' ? (
          <TopicTaxonomyManager />
        ) : activeFacet === 'geography' ? (
          loading ? (
            <Text>Loading…</Text>
          ) : (
            <GeographyTable
              tags={byFacet['geography'] ?? []}
              isAdmin={isAdmin}
              onNotice={(s) => setNotice(s)}
              onError={(s) => setError(s)}
              onReload={load}
            />
          )
        ) : loading ? (
          <Text>Loading…</Text>
        ) : tags.length === 0 ? (
          <Text>No tags yet.</Text>
        ) : (
          distinctFacets
            .filter((f) => f === activeFacet)
            .map((facet) => (
              <FacetTable
                key={facet}
                facet={facet}
                tags={byFacet[facet]}
                isAdmin={isAdmin}
                onNotice={(s) => setNotice(s)}
                onError={(s) => setError(s)}
                onReload={load}
              />
            ))
        )}
      </Box>

      {/* Add form (only for facets without a dedicated manager) */}
      {activeFacet !== 'topic' && activeFacet !== 'geography' && (
        <>
          <Heading size='md' style={{ marginBottom: 12, marginTop: 16 }}>
            New tag
          </Heading>
          <form
            onSubmit={addTag}
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              alignItems: 'flex-start',
            }}
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
                style={{
                  fontFamily: 'inherit',
                  fontSize: 'inherit',
                  padding: '2px 6px',
                }}
              />
            )}
            <input
              placeholder='Value'
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              required
              style={{
                fontFamily: 'inherit',
                fontSize: 'inherit',
                padding: '2px 6px',
              }}
            />
            <button
              type='submit'
              disabled={addBusy}
              className='admin-btn'
              style={actionButton}
            >
              Add
            </button>
          </form>
        </>
      )}
    </Box>
  )
}

const TagsPageWrapper = () => (
  <Suspense
    fallback={
      <Box style={{ padding: 24 }}>
        <Text>Loading…</Text>
      </Box>
    }
  >
    <TagsPage />
  </Suspense>
)

export default TagsPageWrapper
