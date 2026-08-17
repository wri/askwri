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

/** Flatten the tree into a display order (DFS, roots first). */
function flattenTree(tags: TopicRow[]): TopicRow[] {
  const childrenMap = buildChildrenMap(tags)
  const roots = childrenMap.get(null) ?? []
  const result: TopicRow[] = []
  const visit = (tag: TopicRow, depth: number) => {
    result.push(tag)
    const children = childrenMap.get(tag.id) ?? []
    for (const child of children) {
      visit(child, depth + 1)
    }
  }
  for (const root of roots) {
    visit(root, 0)
  }
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
  const sentinelRef = useRef<HTMLDivElement>(null)
  const ioRef = useRef<IntersectionObserver | null>(null)

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

  // ---- progressive render via IntersectionObserver ----
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((prev) => prev + PAGE_SIZE)
        }
      },
      { rootMargin: '200px' },
    )
    ioRef.current = io
    io.observe(sentinel)
    return () => {
      io.disconnect()
      ioRef.current = null
    }
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
    if (useTree) return flattenTree(filteredTags) // DFS order for tree
    return [...filteredTags].sort((a, b) => a.valueId.localeCompare(b.valueId))
  }, [filteredTags, isSearching, useTree])

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
                <Box style={{ flex: 1, minWidth: 0 }}>
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
            <div ref={sentinelRef} style={{ height: 1, background: 'transparent' }} />
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
    </Box>
  )
}

// ---- sub-components ----

const Stat = ({ label, value }: { label: string; value: number }) => (
  <Box
    style={{
      background: '#f7f7f7',
      border: '1px solid #e2e8f0',
      borderRadius: 8,
      padding: '6px 11px',
      fontSize: 11,
      color: '#595959',
    }}
  >
    <Box as='span' style={{ fontSize: 14, fontWeight: 700, color: '#2d3748' }}>
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
