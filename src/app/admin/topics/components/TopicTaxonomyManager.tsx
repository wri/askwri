'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Heading, Text } from '@chakra-ui/react'
import { adminFetch } from '../../lib/api'

// ---- types ----

interface TopicRow {
  id: string
  facet: string
  valueId: string
  taxonomyVersion: string
  parentTagId: string | null
  description: string | null
  aliases: string[]
  acceptedCount: number
  suggestedCount: number
  needsReembed: boolean
}

// ---- constants ----

const PAGE_SIZE = 200

// ---- helpers ----

/** Build a map of parentTagId → children. Roots have parentTagId=null. */
function buildChildrenMap(tags: TopicRow[]): Map<string | null, TopicRow[]> {
  const map = new Map<string | null, TopicRow[]>()
  for (const t of tags) {
    const key = t.parentTagId
    const arr = map.get(key)
    if (arr) arr.push(t)
    else map.set(key, [t])
  }
  // Sort each group by valueId
  for (const arr of map.values()) {
    arr.sort((a, b) => a.valueId.localeCompare(b.valueId))
  }
  return map
}

/** Flatten the tree into a display order (DFS, roots first).
 *  Only recurses into children whose parent is expanded. */
function flattenTree(tags: TopicRow[], expanded: Set<string>): TopicRow[] {
  const childrenMap = buildChildrenMap(tags)
  const roots = childrenMap.get(null) ?? []
  const result: TopicRow[] = []
  const visit = (tag: TopicRow) => {
    result.push(tag)
    if (!expanded.has(tag.id)) return // collapsed: don't recurse
    for (const child of childrenMap.get(tag.id) ?? []) visit(child)
  }
  for (const root of roots) visit(root)
  return result
}

/** Check whether any tag has a non-null parentTagId (tree mode makes sense). */
function hasTree(tags: TopicRow[]): boolean {
  return tags.some((t) => t.parentTagId !== null)
}

// ---- component ----

export const TopicTaxonomyManager = () => {
  const [tags, setTags] = useState<TopicRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const ioRef = useRef<IntersectionObserver | null>(null)

  // ---- edit drawer state ----
  const [editingTag, setEditingTag] = useState<TopicRow | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  // ---- load ----
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const body = await adminFetch<{ ok: boolean; tags: TopicRow[] }>(
        '/api/admin/topics',
      )
      setTags(body.tags ?? [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  // ---- expand all roots by default once tags load ----
  useEffect(() => {
    if (tags.length > 0 && viewMode === 'tree' && hasTree(tags)) {
      const roots = tags.filter((t) => t.parentTagId === null)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExpanded(new Set(roots.map((t) => t.id)))
    }
  }, [tags, viewMode])

  // ---- progressive render via IntersectionObserver (callback ref) ----
  // A callback ref attaches whenever the sentinel node mounts (after loading
  // completes), and cleans up on unmount — unlike a useEffect with empty deps
  // which runs once at mount when the sentinel isn't in the DOM yet.
  const sentinelCallbackRef = useCallback((node: HTMLDivElement | null) => {
    if (ioRef.current) {
      ioRef.current.disconnect()
      ioRef.current = null
    }
    if (!node || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((prev) => prev + PAGE_SIZE)
        }
      },
      { rootMargin: '200px' },
    )
    ioRef.current = io
    io.observe(node)
  }, [])

  // ---- search filter ----
  const filteredTags = useMemo(() => {
    if (!search.trim()) return tags
    const q = search.toLowerCase()
    return tags.filter((t) => {
      if (t.valueId.toLowerCase().includes(q)) return true
      if (t.description && t.description.toLowerCase().includes(q)) return true
      if (t.aliases.some((a) => a.toLowerCase().includes(q))) return true
      return false
    })
  }, [tags, search])

  // ---- display list: flat on search, tree or flat per toggle ----
  const isSearching = search.trim().length > 0
  const useTree = !isSearching && viewMode === 'tree' && hasTree(filteredTags)
  const displayList = useMemo(() => {
    if (isSearching) return filteredTags // flat filtered list on search
    if (useTree) return flattenTree(filteredTags, expanded) // DFS order, collapsed nodes hide children
    return [...filteredTags].sort((a, b) => a.valueId.localeCompare(b.valueId))
  }, [filteredTags, isSearching, useTree, expanded])

  // Build depth map for tree indentation
  const depthMap = useMemo(() => {
    if (!useTree) return new Map<string, number>()
    const childrenMap = buildChildrenMap(filteredTags)
    const map = new Map<string, number>()
    const visit = (tagId: string, depth: number) => {
      map.set(tagId, depth)
      for (const child of childrenMap.get(tagId) ?? []) {
        visit(child.id, depth + 1)
      }
    }
    for (const root of childrenMap.get(null) ?? []) {
      visit(root.id, 0)
    }
    return map
  }, [filteredTags, useTree])

  // Build children count for tree toggle display
  const childrenMap = useMemo(
    () => (useTree ? buildChildrenMap(filteredTags) : new Map<string | null, TopicRow[]>()),
    [filteredTags, useTree],
  )

  const visibleTags = displayList.slice(0, visibleCount)
  const hasMore = displayList.length > visibleCount

  // ---- stats ----
  const topicCount = tags.length
  const docsTagged = tags.reduce((sum, t) => sum + t.acceptedCount, 0)
  const suggestedCount = tags.reduce((sum, t) => sum + t.suggestedCount, 0)
  const needsReembedCount = tags.filter((t) => t.needsReembed).length

  // ---- toggle expand ----
  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ---- render ----
  return (
    <Box style={{ paddingBottom: 48 }}>
      <Heading
        size='lg'
        style={{ marginBottom: 8, color: '#1a365d' }}
      >
        Topic taxonomy
      </Heading>
      <Text
        style={{ marginBottom: 16, color: '#595959', fontStyle: 'italic' }}
      >
        The controlled vocabulary of topics used to classify documents.
        Language-neutral; extensible to other facets later.
      </Text>

      {/* Stats strip */}
      <Box style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <Stat label='topics' value={topicCount} />
        <Stat label='docs tagged' value={docsTagged} />
        <Stat label='suggested' value={suggestedCount} />
        {needsReembedCount > 0 && (
          <Stat label='need re-embed' value={needsReembedCount} warn />
        )}
      </Box>

      {/* Toolbar */}
      <Box
        style={{
          display: 'flex',
          gap: 7,
          alignItems: 'center',
          marginBottom: 10,
          flexWrap: 'wrap',
        }}
      >
        <input
          placeholder='Search topics, aliases…'
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setVisibleCount(PAGE_SIZE) // reset pagination on search
          }}
          style={{
            flex: 1,
            minWidth: 120,
            border: '1px solid #e2e8f0',
            borderRadius: 7,
            padding: '6px 10px',
            fontSize: 13,
            fontFamily: 'inherit',
            color: '#4a5568',
          }}
        />
        {!isSearching && hasTree(tags) && (
          <Box
            style={{
              display: 'flex',
              border: '1px solid #e2e8f0',
              borderRadius: 7,
              overflow: 'hidden',
            }}
          >
            <ViewToggle
              label='Tree'
              active={viewMode === 'tree'}
              onClick={() => setViewMode('tree')}
            />
            <ViewToggle
              label='Flat'
              active={viewMode === 'flat'}
              onClick={() => setViewMode('flat')}
            />
          </Box>
        )}
      </Box>

      {/* Error */}
      {error && (
        <Box
          style={{
            padding: '8px 12px',
            marginBottom: 10,
            color: '#C11101',
            background: '#FDEDEC',
            border: '1px solid #f0b4b4',
            borderRadius: 6,
          }}
        >
          {error}
        </Box>
      )}

      {/* Flash notice */}
      {flash && (
        <Box
          style={{
            padding: '8px 12px',
            marginBottom: 10,
            color: '#2f855a',
            background: '#f0fff4',
            border: '1px solid #c6f6d5',
            borderRadius: 6,
          }}
        >
          {flash}
        </Box>
      )}

      {/* List */}
      {loading ? (
        <Text style={{ color: '#595959' }}>Loading…</Text>
      ) : visibleTags.length === 0 ? (
        <Text style={{ color: '#595959' }}>
          {isSearching ? 'No topics match your search.' : 'No topics yet.'}
        </Text>
      ) : (
        <Box
          style={{
            border: '1px solid #e2e8f0',
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          {/* Header row */}
          <Box
            style={{
              display: 'flex',
              padding: '7px 10px',
              background: '#f7f7f7',
              borderBottom: '1px solid #e2e8f0',
              fontSize: 11,
              color: '#595959',
              textTransform: 'uppercase',
              letterSpacing: '0.05em' as const,
            }}
          >
            <Box style={{ width: 14 }} />
            <Box style={{ flex: 1 }}>Topic</Box>
            <Box style={{ width: 50, textAlign: 'right' }}>Docs</Box>
          </Box>
          {/* Data rows */}
          {visibleTags.map((tag) => {
            const depth = depthMap.get(tag.id) ?? 0
            const indent = useTree ? depth * 18 : 0
            const children = childrenMap.get(tag.id) ?? []
            const hasChildren = children.length > 0
            const isExpanded = expanded.has(tag.id)
            return (
              <Box
                key={tag.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 10px',
                  borderBottom: '1px solid #edf2f7',
                  paddingLeft: 10 + indent,
                }}
              >
                {/* Chevron for tree nodes with children */}
                {useTree && hasChildren ? (
                  <Box
                    as='span'
                    onClick={() => toggleExpand(tag.id)}
                    style={{
                      width: 14,
                      cursor: 'pointer',
                      color: '#a0aec0',
                      fontSize: 11,
                      textAlign: 'center',
                      userSelect: 'none',
                    }}
                  >
                    {isExpanded ? '▾' : '▸'}
                  </Box>
                ) : (
                  <Box style={{ width: 14, textAlign: 'center' }}>
                    {useTree ? '•' : ''}
                  </Box>
                )}
                {/* Label + sub-text */}
                <Box style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setEditingTag(tag)}>
                  <Box
                    as='span'
                    style={{
                      fontWeight: 600,
                      color: '#2d3748',
                      fontSize: 13,
                    }}
                  >
                    {tag.valueId}
                  </Box>
                  {tag.description && (
                    <Box
                      as='span'
                      style={{ color: '#718096', fontSize: 11, marginLeft: 6 }}
                    >
                      {tag.aliases.length > 0
                        ? `aliased: ${tag.aliases.join(', ')}`
                        : tag.description}
                    </Box>
                  )}
                  {!tag.description && tag.aliases.length > 0 && (
                    <Box
                      as='span'
                      style={{ color: '#718096', fontSize: 11, marginLeft: 6 }}
                    >
                      aliased: {tag.aliases.join(', ')}
                    </Box>
                  )}
                </Box>
                {/* Doc count */}
                <Box
                  style={{
                    fontSize: 11,
                    color: '#595959',
                    background: '#f7f7f7',
                    border: '1px solid #e2e8f0',
                    borderRadius: 999,
                    padding: '1px 8px',
                    minWidth: 50,
                    textAlign: 'center' as const,
                  }}
                >
                  {tag.acceptedCount}
                </Box>
              </Box>
            )
          })}
          {/* Progressive-render sentinel */}
          {hasMore && (
            <div ref={sentinelCallbackRef} style={{ height: 1, background: 'transparent' }} />
          )}
        </Box>
      )}

      {/* Footer count */}
      <Text
        style={{
          marginTop: 8,
          fontSize: 12,
          color: '#595959',
        }}
      >
        {displayList.length} tags{hasMore ? `, showing ${visibleTags.length}` : ''}
      </Text>

      {/* Edit drawer */}
      {editingTag && (
        <EditDrawer
          tag={editingTag}
          allTags={tags}
          onClose={() => setEditingTag(null)}
          onSaved={() => {
            setFlash('Topic saved.')
            setTimeout(() => setFlash(null), 3000)
            load()
          }}
        />
      )}
    </Box>
  )
}

// ---- sub-components ----

const Stat = ({ label, value, warn }: { label: string; value: number; warn?: boolean }) => (
  <Box
    style={{
      background: warn ? '#fffbeb' : '#f7f7f7',
      border: `1px solid ${warn ? '#f6e2b3' : '#e2e8f0'}`,
      borderRadius: 8,
      padding: '6px 11px',
      fontSize: 11,
      color: warn ? '#b7791f' : '#595959',
    }}
  >
    <Box as='span' style={{ fontSize: 14, fontWeight: 700, color: warn ? '#b7791f' : '#2d3748' }}>
      {value}
    </Box>{' '}
    {label}
  </Box>
)

const ViewToggle = ({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) => (
  <Box
    as='button'
    onClick={onClick}
    style={{
      padding: '5px 10px',
      fontSize: 11,
      border: 'none',
      cursor: 'pointer',
      background: active ? '#1a365d' : '#fff',
      color: active ? '#fff' : '#595959',
      fontFamily: 'inherit',
    }}
  >
    {label}
  </Box>
)

// ---- Edit Drawer ----

interface HistoryEntry {
  at: string
  action: string
  source: string
  actor: string
  before: Record<string, any> | null
  after: Record<string, any> | null
}

const EditDrawer = ({
  tag,
  allTags,
  onClose,
  onSaved,
}: {
  tag: TopicRow
  allTags: TopicRow[]
  onClose: () => void
  onSaved: () => void
}) => {
  const [tab, setTab] = useState<'edit' | 'history' | 'docs'>('edit')
  const [label, setLabel] = useState(tag.valueId)
  const [description, setDescription] = useState(tag.description ?? '')
  const [aliases, setAliases] = useState<string[]>(tag.aliases)
  const [aliasInput, setAliasInput] = useState('')
  const [parentTagId, setParentTagId] = useState<string>(tag.parentTagId ?? '')
  const [saving, setSaving] = useState(false)
  const [parentError, setParentError] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // Parent options: all topic tags except self
  const parentOptions = useMemo(
    () => allTags.filter((t) => t.id !== tag.id),
    [allTags, tag.id],
  )

  // Load history when History tab is clicked
  useEffect(() => {
    if (tab !== 'history' || history.length > 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistoryLoading(true)
    fetch(`/api/admin/topics/${tag.id}/history`)
      .then((r) => (r.ok ? r.json() : { entries: [] }))
      .then((body) => setHistory(body.entries ?? []))
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const addAlias = () => {
    const trimmed = aliasInput.trim()
    if (trimmed && !aliases.includes(trimmed)) {
      setAliases([...aliases, trimmed])
    }
    setAliasInput('')
  }

  const removeAlias = (alias: string) => {
    setAliases(aliases.filter((a) => a !== alias))
  }

  const handleSave = async () => {
    setSaving(true)
    setParentError(null)
    try {
      await adminFetch(`/api/admin/topics/${tag.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          valueId: label !== tag.valueId ? label : undefined,
          description: description || null,
          aliases,
          parentTagId: parentTagId || null,
        }),
      })
      onSaved()
      onClose()
    } catch (err: any) {
      if (err.message === 'cycle') {
        setParentError('Would create a cycle')
      } else {
        setParentError(err.message)
      }
    } finally {
      setSaving(false)
    }
  }

  const fieldLabel: React.CSSProperties = {
    display: 'block',
    fontSize: 10,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    color: '#595959',
    marginBottom: 3,
  }
  const inputStyle: React.CSSProperties = {
    width: '100%',
    border: '1px solid #e2e8f0',
    borderRadius: 6,
    padding: '5px 8px',
    fontSize: 12,
    fontFamily: 'inherit',
    color: '#2d3748',
  }

  return (
    <>
      {/* Overlay */}
      <Box
        onClick={onClose}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(26,54,93,0.35)',
          zIndex: 100,
        }}
      />
      {/* Drawer */}
      <Box
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          height: '100vh',
          width: 380,
          background: '#fff',
          borderLeft: '1px solid #e2e8f0',
          boxShadow: '-12px 0 40px rgba(26,54,93,0.15)',
          zIndex: 101,
          overflowY: 'auto',
          padding: 16,
        }}
      >
        {/* Header */}
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Heading size='sm' style={{ color: '#1a365d' }}>Edit topic</Heading>
          <Box as='button' onClick={onClose} style={{ font: 'inherit', color: '#a0aec0', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 16 }}>
            ✕
          </Box>
        </Box>

        {/* Tabs */}
        <Box style={{ display: 'flex', gap: 14, borderBottom: '1px solid #e2e8f0', marginBottom: 12 }}>
          {(['edit', 'history', 'docs'] as const).map((t) => (
            <Box
              key={t}
              as='button'
              onClick={() => setTab(t)}
              style={{
                font: 'inherit',
                fontSize: 12,
                padding: '5px 2px',
                border: 'none',
                borderBottom: tab === t ? '2px solid #1a365d' : '2px solid transparent',
                color: tab === t ? '#1a365d' : '#595959',
                fontWeight: tab === t ? 700 : 400,
                cursor: 'pointer',
                background: 'transparent',
                textTransform: 'capitalize' as const,
              }}
            >
              {t === 'docs' ? `Docs (${tag.acceptedCount})` : t === 'history' ? 'History' : 'Edit'}
            </Box>
          ))}
        </Box>

        {/* Edit tab */}
        {tab === 'edit' && (
          <Box>
            <Box style={{ marginBottom: 9 }}>
              <label style={fieldLabel}>Label</label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                style={inputStyle}
              />
            </Box>
            <Box style={{ marginBottom: 9 }}>
              <label style={fieldLabel}>Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                style={{ ...inputStyle, minHeight: 50, resize: 'vertical' as const }}
              />
            </Box>
            <Box style={{ marginBottom: 9 }}>
              <label style={fieldLabel}>Aliases</label>
              <Box style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                {aliases.map((a) => (
                  <Box key={a} style={{
                    fontSize: 11,
                    background: '#ebf4ff',
                    color: '#1a365d',
                    border: '1px solid #c3dafe',
                    borderRadius: 999,
                    padding: '2px 8px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}>
                    {a}
                    <Box as='button' onClick={() => removeAlias(a)} style={{ font: 'inherit', color: '#a0aec0', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, fontSize: 11 }}>
                      ✕
                    </Box>
                  </Box>
                ))}
              </Box>
              <Box style={{ display: 'flex', gap: 4 }}>
                <input
                  value={aliasInput}
                  onChange={(e) => setAliasInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAlias() } }}
                  placeholder='Add alias…'
                  style={{ ...inputStyle, flex: 1 }}
                />
                <Box as='button' onClick={addAlias} style={{ font: 'inherit', fontSize: 11, border: '1px solid #e2e8f0', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', color: '#1a365d', background: '#fff' }}>
                  Add
                </Box>
              </Box>
            </Box>
            <Box style={{ marginBottom: 9 }}>
              <label style={fieldLabel}>Parent topic</label>
              <select
                value={parentTagId}
                onChange={(e) => { setParentTagId(e.target.value); setParentError(null) }}
                style={inputStyle}
              >
                <option value=''>(root)</option>
                {parentOptions.map((t) => (
                  <option key={t.id} value={t.id}>{t.valueId}</option>
                ))}
              </select>
              {parentError && (
                <Box style={{ fontSize: 11, color: '#C11101', marginTop: 3 }}>
                  {parentError}
                </Box>
              )}
            </Box>
            {/* Save / Cancel */}
            <Box style={{ display: 'flex', gap: 7, justifyContent: 'flex-end', marginTop: 12 }}>
              <Box as='button' onClick={onClose} style={{ font: 'inherit', fontSize: 11, border: '1px solid #e2e8f0', borderRadius: 7, padding: '5px 10px', cursor: 'pointer', color: '#1a365d', background: '#fff' }}>
                Cancel
              </Box>
              <Box as='button' onClick={handleSave} disabled={saving} style={{ font: 'inherit', fontSize: 11, border: '1px solid #1a365d', borderRadius: 7, padding: '5px 10px', cursor: 'pointer', color: '#fff', background: '#1a365d', opacity: saving ? 0.5 : 1 }}>
                {saving ? 'Saving…' : 'Save'}
              </Box>
            </Box>
          </Box>
        )}

        {/* History tab */}
        {tab === 'history' && (
          <Box>
            {historyLoading ? (
              <Text style={{ color: '#595959', fontSize: 12 }}>Loading history…</Text>
            ) : history.length === 0 ? (
              <Text style={{ color: '#595959', fontSize: 12 }}>No history entries.</Text>
            ) : (
              history.map((entry, i) => (
                <Box key={i} style={{ padding: '8px 0', borderBottom: '1px solid #edf2f7' }}>
                  <Box style={{ fontSize: 12, fontWeight: 600, color: '#1a365d' }}>{entry.action}</Box>
                  <Box style={{ fontSize: 11, color: '#595959' }}>
                    {entry.actor} · {new Date(entry.at).toLocaleDateString()}
                  </Box>
                  {entry.before && (
                    <Box style={{ fontSize: 11, color: '#718096', marginTop: 2 }}>
                      before: {JSON.stringify(entry.before)}
                    </Box>
                  )}
                  {entry.after && (
                    <Box style={{ fontSize: 11, color: '#718096' }}>
                      after: {JSON.stringify(entry.after)}
                    </Box>
                  )}
                </Box>
              ))
            )}
          </Box>
        )}

        {/* Docs tab */}
        {tab === 'docs' && (
          <Box>
            <Text style={{ fontSize: 12, color: '#595959' }}>
              {tag.acceptedCount} accepted · {tag.suggestedCount} suggested
            </Text>
          </Box>
        )}
      </Box>
    </>
  )
}
