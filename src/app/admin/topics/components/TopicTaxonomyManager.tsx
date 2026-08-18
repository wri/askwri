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

type Notice =
  { kind: 'success'; message: string } | { kind: 'error'; message: string }

interface ReclassifyConfirmation {
  requestId: number
  scope: 'all' | string
  estimate: { eligible: number; estCost: number } | null
  error: string | null
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

function descendantIds(
  tags: TopicRow[],
  tagIds: Iterable<string>,
): Set<string> {
  const children = buildChildrenMap(tags)
  const descendants = new Set<string>()
  const pending = [...tagIds]
  while (pending.length > 0) {
    const id = pending.pop()!
    for (const child of children.get(id) ?? []) {
      if (descendants.has(child.id)) continue
      descendants.add(child.id)
      pending.push(child.id)
    }
  }
  return descendants
}

function useEscapeClose(onClose: () => void, busy = false) {
  useEffect(() => {
    if (busy) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [busy, onClose])
}

const DIALOG_FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function useDialogBehavior(onClose: () => void, busy = false) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const busyRef = useRef(busy)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    const returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const dialog = dialogRef.current
    const initialFocus =
      dialog?.querySelector<HTMLElement>('[data-autofocus]') ?? dialog
    initialFocus?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!busyRef.current) {
          event.preventDefault()
          onCloseRef.current()
        }
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE),
      )
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (
        event.shiftKey &&
        (active === first || !dialogRef.current.contains(active))
      ) {
        event.preventDefault()
        last.focus()
      } else if (
        !event.shiftKey &&
        (active === last || !dialogRef.current.contains(active))
      ) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (returnFocus?.isConnected) returnFocus.focus()
    }
  }, [])

  return dialogRef
}

// ---- component ----

export const TopicTaxonomyManager = () => {
  const [tags, setTags] = useState<TopicRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [parentFilter, setParentFilter] = useState<'all' | 'root' | 'child'>(
    'all',
  )
  const [minimumDocs, setMinimumDocs] = useState('')
  const [maximumDocs, setMaximumDocs] = useState('')
  const [reembedFilter, setReembedFilter] = useState<
    'all' | 'needed' | 'current'
  >('all')
  const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const ioRef = useRef<IntersectionObserver | null>(null)

  // ---- edit drawer state ----
  const [editingTag, setEditingTag] = useState<TopicRow | null>(null)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [rebuildBusy, setRebuildBusy] = useState(false)
  const [embedProgress, setEmbedProgress] = useState<{
    total: number
    embedded: number
    pending: number
  } | null>(null)
  const embedPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---- bulk ops state ----
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mergeModalOpen, setMergeModalOpen] = useState(false)
  const [reparentModalOpen, setReparentModalOpen] = useState(false)
  const [deleteResults, setDeleteResults] = useState<{
    deleted: number
    failed: { label: string; reason: string }[]
  } | null>(null)

  // ---- CSV import/export state ----
  const [csvDiff, setCsvDiff] = useState<{
    added: {
      label: string
      description: string
      aliases: string[]
      parent: string
      facet: string
      id: string
    }[]
    updated: {
      row: {
        label: string
        description: string
        aliases: string[]
        parent: string
        facet: string
        id: string
      }
      current: any
    }[]
    unchanged: {
      label: string
      description: string
      aliases: string[]
      parent: string
      facet: string
      id: string
    }[]
    conflicts: {
      row: {
        label: string
        description: string
        aliases: string[]
        parent: string
        facet: string
        id: string
      }
      reason: string
    }[]
  } | null>(null)
  const [csvLoading, setCsvLoading] = useState(false)
  const [csvError, setCsvError] = useState<string | null>(null)
  const [csvReclassify, setCsvReclassify] = useState(true)
  const [csvApplying, setCsvApplying] = useState(false)
  const [csvFilename, setCsvFilename] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ---- reclassify state ----
  const [reclassifyConfirmation, setReclassifyConfirmation] =
    useState<ReclassifyConfirmation | null>(null)
  const [reclassifyStarting, setReclassifyStarting] = useState(false)
  const reclassifyStartingRef = useRef(false)
  const reclassifyRequestIdRef = useRef(0)
  const reclassifyPostIdRef = useRef(0)

  const [reclassifyStatus, setReclassifyStatus] = useState<{
    queued: number
    running: number
    done: number
    error: number
    recent: {
      runId: string
      scope: 'all' | string
      total: number
      done: number
      error: number
      estCost: number
      createdAt: string
      updatedAt: string
      errors: {
        documentId: string
        externalId: string
        title: string | null
        attempts: number
        error: string | null
      }[]
    }[]
  } | null>(null)
  const [reclassifyPanelOpen, setReclassifyPanelOpen] = useState(false)
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set())
  const reclassifyTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Scoped topic picker
  const [scopedTopicId, setScopedTopicId] = useState('')
  const [scopedModalOpen, setScopedModalOpen] = useState(false)

  const showNotice = useCallback(
    (kind: Notice['kind'], message: string, duration = 3000) => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
      setNotice({ kind, message })
      noticeTimerRef.current = setTimeout(() => {
        setNotice(null)
        noticeTimerRef.current = null
      }, duration)
    },
    [],
  )

  useEffect(
    () => () => {
      reclassifyRequestIdRef.current += 1
      reclassifyPostIdRef.current += 1
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    },
    [],
  )

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

  // ---- tag-embed sweep progress (read-only GET on the rebuild route) ----
  // After a big import or a Rebuild, the worker's embed sweep drains
  // tags.needs_reembed asynchronously. Poll while there are pending tags so
  // the admin sees "embedded/total (pending N)" settle to 0 instead of guessing.
  const loadEmbedProgress = useCallback(async () => {
    try {
      const body = await adminFetch<{
        ok: boolean
        total: number
        embedded: number
        pending: number
      }>('/api/admin/topics/embeddings/rebuild')
      setEmbedProgress({
        total: body.total,
        embedded: body.embedded,
        pending: body.pending,
      })
    } catch {
      // Non-fatal: the panel degrades to no count.
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadEmbedProgress()
    if (embedPollRef.current) clearInterval(embedPollRef.current)
    embedPollRef.current = setInterval(loadEmbedProgress, 5000)
    return () => {
      if (embedPollRef.current) clearInterval(embedPollRef.current)
      embedPollRef.current = null
    }
  }, [loadEmbedProgress])

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
    const q = search.toLowerCase()
    return tags.filter((t) => {
      const matchesSearch =
        !q.trim() ||
        t.valueId.toLowerCase().includes(q) ||
        Boolean(t.description?.toLowerCase().includes(q)) ||
        t.aliases.some((a) => a.toLowerCase().includes(q))
      if (!matchesSearch) return false
      if (parentFilter === 'root' && t.parentTagId !== null) return false
      if (parentFilter === 'child' && t.parentTagId === null) return false
      if (minimumDocs !== '' && t.acceptedCount < Number(minimumDocs))
        return false
      if (maximumDocs !== '' && t.acceptedCount > Number(maximumDocs))
        return false
      if (reembedFilter === 'needed' && !t.needsReembed) return false
      if (reembedFilter === 'current' && t.needsReembed) return false
      return true
    })
  }, [tags, search, parentFilter, minimumDocs, maximumDocs, reembedFilter])

  // ---- display list: flat on search, tree or flat per toggle ----
  const isSearching = search.trim().length > 0
  const isFiltering =
    parentFilter !== 'all' ||
    minimumDocs !== '' ||
    maximumDocs !== '' ||
    reembedFilter !== 'all'
  const useTree =
    !isSearching && !isFiltering && viewMode === 'tree' && hasTree(filteredTags)
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
    () =>
      useTree
        ? buildChildrenMap(filteredTags)
        : new Map<string | null, TopicRow[]>(),
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

  // ---- bulk ops ----
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = () => setSelected(new Set())

  const selectedTags = useMemo(
    () => tags.filter((t) => selected.has(t.id)),
    [tags, selected],
  )

  const handleDelete = async () => {
    let deleted = 0
    const failed: { label: string; reason: string }[] = []
    for (const tag of selectedTags) {
      try {
        const res = await fetch(`/api/admin/topics/${tag.id}`, {
          method: 'DELETE',
        })
        const body = await res.json().catch(() => ({}))
        if (res.status === 401) {
          window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
          return
        }
        if (res.ok) {
          deleted++
        } else {
          failed.push({
            label: tag.valueId,
            reason: body.error || 'unknown error',
          })
        }
      } catch {
        failed.push({ label: tag.valueId, reason: 'network error' })
      }
    }
    setDeleteResults({ deleted, failed })
    if (deleted > 0) {
      showNotice(
        'success',
        `${deleted} topic${deleted !== 1 ? 's' : ''} deleted.`,
      )
      load()
    }
    setSelected(new Set())
  }

  const handleRebuildEmbeddings = async () => {
    setRebuildBusy(true)
    try {
      const res = await fetch('/api/admin/topics/embeddings/rebuild', {
        method: 'POST',
      })
      if (res.status === 401) {
        window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
        return
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) {
        showNotice('error', body.error || 'Embedding rebuild failed.')
        return
      }
      showNotice(
        'success',
        `Queued ${body.queued} topic embeddings for rebuild.`,
      )
      load()
      loadEmbedProgress()
    } catch {
      showNotice('error', 'Embedding rebuild failed.')
    } finally {
      setRebuildBusy(false)
    }
  }

  // ---- CSV import/export ----
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvFilename(file.name)
    setCsvLoading(true)
    setCsvError(null)
    setCsvDiff(null)
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error('Failed to read file'))
        reader.readAsText(file)
      })
      if (!text.trim()) {
        setCsvError('CSV file is empty.')
        setCsvLoading(false)
        return
      }
      const res = await fetch('/api/admin/topics/import?dry_run=true', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: text,
      })
      if (res.status === 401) {
        window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
        return
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) {
        setCsvError(body.error || 'Failed to parse CSV.')
        setCsvLoading(false)
        return
      }
      setCsvDiff(body.diff)
    } catch (err: any) {
      setCsvError(err.message || 'Network error.')
    }
    setCsvLoading(false)
  }

  const handleApplyImport = async () => {
    if (!csvDiff || csvDiff.conflicts.length > 0) return
    setCsvApplying(true)
    setCsvError(null)
    try {
      // Re-read the file to get the CSV text
      const file = fileInputRef.current?.files?.[0]
      if (!file) {
        setCsvError('File not found. Please re-select.')
        setCsvApplying(false)
        return
      }
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error('Failed to read file'))
        reader.readAsText(file)
      })
      const res = await fetch(
        `/api/admin/topics/import?reclassify=${csvReclassify}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/csv' },
          body: text,
        },
      )
      if (res.status === 401) {
        window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
        return
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) {
        setCsvError(body.error || 'Apply failed.')
        setCsvApplying(false)
        return
      }
      showNotice(
        'success',
        `Imported ${body.applied} change${body.applied !== 1 ? 's' : ''}.`,
      )
      setCsvDiff(null)
      setCsvFilename('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      load()
    } catch (err: any) {
      setCsvError(err.message || 'Network error.')
    }
    setCsvApplying(false)
  }

  const closeCsvModal = () => {
    setCsvDiff(null)
    setCsvError(null)
    setCsvFilename('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleExport = async () => {
    try {
      const res = await fetch('/api/admin/topics/export')
      if (res.status === 401) {
        window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
        return
      }
      if (!res.ok) {
        showNotice('error', 'Export failed.')
        return
      }
      const text = await res.text()
      const blob = new Blob([text], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'topic-taxonomy.csv'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      showNotice('error', 'Export failed.')
    }
  }

  // ---- reclassify handlers ----

  const fetchReclassifyStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/topics/reclassify/status')
      if (res.status === 401) {
        window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
        return
      }
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.ok !== false) {
        const { ok: _ok, ...rest } = body
        setReclassifyStatus(rest)
      }
    } catch {
      // Best-effort polling; don't spam errors
    }
  }, [])

  // Poll status every 5s when panel is open
  useEffect(() => {
    if (reclassifyPanelOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchReclassifyStatus()
      reclassifyTimerRef.current = setInterval(fetchReclassifyStatus, 5000)
    }
    return () => {
      if (reclassifyTimerRef.current) {
        clearInterval(reclassifyTimerRef.current)
        reclassifyTimerRef.current = null
      }
    }
  }, [reclassifyPanelOpen, fetchReclassifyStatus])

  const fetchReclassifyEstimate = async (scope: 'all' | string) => {
    if (reclassifyStartingRef.current) return
    const requestId = reclassifyRequestIdRef.current + 1
    reclassifyRequestIdRef.current = requestId
    setReclassifyConfirmation({ requestId, scope, estimate: null, error: null })
    try {
      const query =
        scope === 'all' ? 'scope=all' : `tagId=${encodeURIComponent(scope)}`
      const res = await fetch(`/api/admin/topics/reclassify?${query}`)
      if (reclassifyRequestIdRef.current !== requestId) return
      if (res.status === 401) {
        window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
        return
      }
      const body = await res.json().catch(() => ({}))
      if (reclassifyRequestIdRef.current !== requestId) return
      if (res.ok && body.ok !== false) {
        setReclassifyConfirmation((current) =>
          current?.requestId === requestId && current.scope === scope
            ? {
                ...current,
                estimate: { eligible: body.eligible, estCost: body.estCost },
              }
            : current,
        )
      } else {
        setReclassifyConfirmation((current) =>
          current?.requestId === requestId && current.scope === scope
            ? {
                ...current,
                error: body.error || 'Failed to estimate re-classify.',
              }
            : current,
        )
      }
    } catch {
      if (reclassifyRequestIdRef.current !== requestId) return
      setReclassifyConfirmation((current) =>
        current?.requestId === requestId && current.scope === scope
          ? { ...current, error: 'Network error.' }
          : current,
      )
    }
  }

  const openReclassifyAll = () => fetchReclassifyEstimate('all')

  const openReclassifyScoped = () => {
    if (reclassifyStartingRef.current) return
    setScopedModalOpen(true)
    setScopedTopicId('')
  }

  const confirmScopedReclassify = () => {
    if (!scopedTopicId) return
    setScopedModalOpen(false)
    fetchReclassifyEstimate(scopedTopicId)
  }

  const closeReclassifyConfirmation = () => {
    if (reclassifyStartingRef.current) return
    reclassifyRequestIdRef.current += 1
    setReclassifyConfirmation(null)
  }

  const handleStartReclassify = async () => {
    const confirmation = reclassifyConfirmation
    if (
      !confirmation?.estimate ||
      confirmation.estimate.eligible === 0 ||
      reclassifyStartingRef.current
    )
      return
    const { requestId, scope } = confirmation
    const postId = reclassifyPostIdRef.current + 1
    reclassifyPostIdRef.current = postId
    reclassifyStartingRef.current = true
    setReclassifyStarting(true)
    setReclassifyConfirmation((current) =>
      current?.requestId === requestId ? { ...current, error: null } : current,
    )
    try {
      const payload =
        scope === 'all' ? { scope: 'all' as const } : { tagId: scope }
      const res = await fetch('/api/admin/topics/reclassify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (
        reclassifyPostIdRef.current !== postId ||
        reclassifyRequestIdRef.current !== requestId
      )
        return
      if (res.status === 401) {
        window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
        return
      }
      const body = await res.json().catch(() => ({}))
      if (
        reclassifyPostIdRef.current !== postId ||
        reclassifyRequestIdRef.current !== requestId
      )
        return
      if (!res.ok || body.ok === false) {
        setReclassifyConfirmation((current) =>
          current?.requestId === requestId
            ? {
                ...current,
                error: body.error || 'Failed to start re-classify.',
              }
            : current,
        )
        return
      }
      reclassifyRequestIdRef.current += 1
      setReclassifyConfirmation(null)
      showNotice(
        'success',
        `Re-classify enqueued: ${body.enqueued} docs (≈$${body.estCost.toFixed(4)}).`,
        4000,
      )
      setReclassifyPanelOpen(true)
    } catch {
      if (
        reclassifyPostIdRef.current === postId &&
        reclassifyRequestIdRef.current === requestId
      ) {
        setReclassifyConfirmation((current) =>
          current?.requestId === requestId
            ? { ...current, error: 'Network error.' }
            : current,
        )
      }
    } finally {
      if (reclassifyPostIdRef.current === postId) {
        reclassifyStartingRef.current = false
        setReclassifyStarting(false)
      }
    }
  }

  const handleRetryRun = async (runId: string) => {
    try {
      const res = await fetch('/api/admin/topics/reclassify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retryRunId: runId }),
      })
      if (res.status === 401) {
        window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
        return
      }
      const resBody = await res.json().catch(() => ({}))
      if (res.ok && resBody.ok !== false) {
        showNotice('success', `Retry enqueued: ${resBody.enqueued} docs.`)
        fetchReclassifyStatus()
      } else {
        showNotice('error', resBody.error || 'Retry failed.')
      }
    } catch {
      showNotice('error', 'Network error during retry.')
    }
  }

  const toggleErrorExpand = (runId: string) => {
    setExpandedErrors((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }

  // ---- render ----
  return (
    <Box style={{ paddingBottom: 48 }}>
      <Heading size='lg' style={{ marginBottom: 8, color: '#1a365d' }}>
        Topic taxonomy
      </Heading>
      <Text style={{ marginBottom: 16, color: '#595959', fontStyle: 'italic' }}>
        The controlled vocabulary of topics used to classify documents.
        Language-neutral; extensible to other facets later.
      </Text>

      {/* Stats strip */}
      <Box
        style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}
      >
        <Stat label='topics' value={topicCount} />
        <Stat label='docs tagged' value={docsTagged} />
        <Stat label='suggested' value={suggestedCount} />
        {needsReembedCount > 0 && (
          <Stat label='need re-embed' value={needsReembedCount} warn />
        )}
      </Box>

      {/* Toolbar or Bulk bar */}
      {selected.size > 0 ? (
        <Box
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            marginBottom: 10,
            flexWrap: 'wrap',
            background: '#ebf4ff',
            border: '1px solid #c3dafe',
            borderRadius: 8,
            padding: '8px 10px',
          }}
        >
          <Box
            as='span'
            style={{ fontSize: 12, fontWeight: 700, color: '#1a365d' }}
          >
            {selected.size} selected
          </Box>
          <button
            className='admin-btn'
            onClick={() => setMergeModalOpen(true)}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #c3dafe',
              borderRadius: 7,
              padding: '4px 10px',
              cursor: 'pointer',
              color: '#1a365d',
              background: '#fff',
              fontWeight: 600,
            }}
          >
            Merge into…
          </button>
          <button
            className='admin-btn'
            onClick={() => setReparentModalOpen(true)}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #c3dafe',
              borderRadius: 7,
              padding: '4px 10px',
              cursor: 'pointer',
              color: '#1a365d',
              background: '#fff',
              fontWeight: 600,
            }}
          >
            Re-parent…
          </button>
          <button
            className='admin-btn'
            onClick={handleDelete}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #f0b4b4',
              borderRadius: 7,
              padding: '4px 10px',
              cursor: 'pointer',
              color: '#C11101',
              background: '#fff',
              fontWeight: 600,
            }}
          >
            Delete unused
          </button>
          <Box style={{ flex: 1 }} />
          <button
            className='admin-btn'
            onClick={() => setSelected(new Set(filteredTags.map((t) => t.id)))}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: 'none',
              background: 'transparent',
              color: '#1a365d',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            Select all
          </button>
          <button
            className='admin-btn'
            onClick={clearSelection}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: 'none',
              background: 'transparent',
              color: '#1a365d',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            Clear
          </button>
        </Box>
      ) : (
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
          <select
            aria-label='Parent state'
            value={parentFilter}
            onChange={(e) => {
              setParentFilter(e.target.value as 'all' | 'root' | 'child')
              setVisibleCount(PAGE_SIZE)
            }}
            style={{
              border: '1px solid #e2e8f0',
              borderRadius: 7,
              padding: '5px 8px',
              fontSize: 11,
              fontFamily: 'inherit',
              color: '#4a5568',
            }}
          >
            <option value='all'>All parents</option>
            <option value='root'>Root only</option>
            <option value='child'>Has parent</option>
          </select>
          <input
            type='number'
            min='0'
            aria-label='Minimum documents'
            placeholder='Min docs'
            value={minimumDocs}
            onChange={(e) => {
              setMinimumDocs(e.target.value)
              setVisibleCount(PAGE_SIZE)
            }}
            style={{
              width: 74,
              border: '1px solid #e2e8f0',
              borderRadius: 7,
              padding: '5px 8px',
              fontSize: 11,
              fontFamily: 'inherit',
              color: '#4a5568',
            }}
          />
          <input
            type='number'
            min='0'
            aria-label='Maximum documents'
            placeholder='Max docs'
            value={maximumDocs}
            onChange={(e) => {
              setMaximumDocs(e.target.value)
              setVisibleCount(PAGE_SIZE)
            }}
            style={{
              width: 74,
              border: '1px solid #e2e8f0',
              borderRadius: 7,
              padding: '5px 8px',
              fontSize: 11,
              fontFamily: 'inherit',
              color: '#4a5568',
            }}
          />
          <select
            aria-label='Re-embed state'
            value={reembedFilter}
            onChange={(e) => {
              setReembedFilter(e.target.value as 'all' | 'needed' | 'current')
              setVisibleCount(PAGE_SIZE)
            }}
            style={{
              border: '1px solid #e2e8f0',
              borderRadius: 7,
              padding: '5px 8px',
              fontSize: 11,
              fontFamily: 'inherit',
              color: '#4a5568',
            }}
          >
            <option value='all'>All embeddings</option>
            <option value='needed'>Needs re-embed</option>
            <option value='current'>Embedding current</option>
          </select>
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
          <button
            className='admin-btn'
            onClick={() => setCreateModalOpen(true)}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #1a365d',
              borderRadius: 7,
              padding: '5px 11px',
              color: '#fff',
              background: '#1a365d',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            New topic
          </button>
          <button
            className='admin-btn'
            onClick={() => fileInputRef.current?.click()}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #e2e8f0',
              borderRadius: 7,
              padding: '5px 11px',
              color: '#1a365d',
              background: '#fff',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Import CSV
          </button>
          <button
            className='admin-btn'
            onClick={handleExport}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #e2e8f0',
              borderRadius: 7,
              padding: '5px 11px',
              color: '#1a365d',
              background: '#fff',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Export CSV
          </button>
          <button
            className='admin-btn'
            onClick={handleRebuildEmbeddings}
            disabled={rebuildBusy}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #e2e8f0',
              borderRadius: 7,
              padding: '5px 11px',
              color: '#1a365d',
              background: '#fff',
              fontWeight: 600,
              cursor: rebuildBusy ? 'wait' : 'pointer',
              opacity: rebuildBusy ? 0.6 : 1,
            }}
          >
            {rebuildBusy ? 'Rebuilding…' : 'Rebuild embeddings'}
          </button>
          {embedProgress && embedProgress.total > 0 && (
            <Text
              style={{
                fontFamily: 'inherit',
                fontSize: 11,
                color: embedProgress.pending > 0 ? '#8a5a15' : '#2f855a',
                whiteSpace: 'nowrap',
              }}
              title={
                embedProgress.pending > 0
                  ? 'Worker embed sweep in progress — polls every 5s'
                  : 'All topic tags have cohere-embed-v4 embeddings'
              }
            >
              Embeddings: {embedProgress.embedded}/{embedProgress.total}
              {embedProgress.pending > 0
                ? ` (${embedProgress.pending} pending)`
                : ' ✓'}
            </Text>
          )}
          <Box style={{ flex: 1 }} />
          <button
            className='admin-btn'
            onClick={openReclassifyAll}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #1a365d',
              borderRadius: 7,
              padding: '5px 11px',
              color: '#fff',
              background: '#1a365d',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Re-classify all
          </button>
          <button
            className='admin-btn'
            onClick={openReclassifyScoped}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #e2e8f0',
              borderRadius: 7,
              padding: '5px 11px',
              color: '#1a365d',
              background: '#fff',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Scoped to topic…
          </button>
          <button
            className='admin-btn'
            onClick={() => {
              setReclassifyPanelOpen(!reclassifyPanelOpen)
            }}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #e2e8f0',
              borderRadius: 7,
              padding: '5px 11px',
              color: '#1a365d',
              background: '#fff',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {reclassifyPanelOpen ? 'Hide' : 'Show'} jobs
          </button>
        </Box>
      )}

      {/* Hidden file input for CSV import */}
      <input
        ref={fileInputRef}
        type='file'
        accept='.csv,text/csv'
        style={{ display: 'none' }}
        onChange={handleFileSelect}
      />

      {/* CSV import modal */}
      {(csvDiff || csvLoading || csvError) && (
        <CsvImportModal
          diff={csvDiff}
          loading={csvLoading}
          error={csvError}
          reclassify={csvReclassify}
          applying={csvApplying}
          filename={csvFilename}
          onReclassifyChange={setCsvReclassify}
          onApply={handleApplyImport}
          onClose={closeCsvModal}
        />
      )}

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

      {/* Success/error notice */}
      {notice && (
        <Box
          role={notice.kind === 'error' ? 'alert' : 'status'}
          aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}
          style={{
            padding: '8px 12px',
            marginBottom: 10,
            color: notice.kind === 'error' ? '#C11101' : '#2f855a',
            background: notice.kind === 'error' ? '#FDEDEC' : '#f0fff4',
            border: `1px solid ${notice.kind === 'error' ? '#f0b4b4' : '#c6f6d5'}`,
            borderRadius: 6,
          }}
        >
          {notice.message}
        </Box>
      )}

      {/* Delete results */}
      {deleteResults && deleteResults.failed.length > 0 && (
        <Box
          style={{
            padding: '8px 12px',
            marginBottom: 10,
            color: '#C11101',
            background: '#fff0f0',
            border: '1px solid #f0b4b4',
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          {deleteResults.deleted > 0 && (
            <Box style={{ marginBottom: 4, color: '#2f855a' }}>
              {deleteResults.deleted} topic
              {deleteResults.deleted !== 1 ? 's' : ''} deleted.
            </Box>
          )}
          {deleteResults.failed.length} tag
          {deleteResults.failed.length !== 1 ? 's' : ''} in use, cannot delete:{' '}
          {deleteResults.failed.map((f) => f.label).join(', ')}
        </Box>
      )}

      {/* List */}
      {loading ? (
        <Text style={{ color: '#595959' }}>Loading…</Text>
      ) : visibleTags.length === 0 ? (
        <Text style={{ color: '#595959' }}>
          {isSearching
            ? 'No topics match your search.'
            : isFiltering
              ? 'No topics match your filters.'
              : 'No topics yet.'}
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
            <Box style={{ width: 14, display: 'flex', alignItems: 'center' }}>
              <input
                type='checkbox'
                checked={
                  visibleTags.length > 0 &&
                  visibleTags.every((t) => selected.has(t.id))
                }
                onChange={(e) => {
                  if (e.target.checked)
                    setSelected(new Set(filteredTags.map((t) => t.id)))
                  else setSelected(new Set())
                }}
                style={{ margin: 0, cursor: 'pointer' }}
              />
            </Box>
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
                <Box
                  style={{ width: 14, display: 'flex', alignItems: 'center' }}
                >
                  <input
                    type='checkbox'
                    checked={selected.has(tag.id)}
                    onChange={(e) => {
                      e.stopPropagation()
                      toggleSelect(tag.id)
                    }}
                    onClick={(e) => e.stopPropagation()}
                    style={{ margin: 0, cursor: 'pointer' }}
                  />
                </Box>
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
                <Box
                  style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                  onClick={() => setEditingTag(tag)}
                >
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
                      {tag.description}
                    </Box>
                  )}
                  {tag.aliases.length > 0 && (
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
            <div
              ref={sentinelCallbackRef}
              style={{ height: 1, background: 'transparent' }}
            />
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
        {displayList.length} tags
        {hasMore ? `, showing ${visibleTags.length}` : ''}
      </Text>

      {/* Edit drawer */}
      {editingTag && (
        <EditDrawer
          tag={editingTag}
          allTags={tags}
          onClose={() => setEditingTag(null)}
          onSaved={() => {
            showNotice('success', 'Topic saved.')
            load()
          }}
        />
      )}

      {/* Create modal */}
      {createModalOpen && (
        <CreateTopicModal
          allTags={tags}
          onClose={() => setCreateModalOpen(false)}
          onCreated={() => {
            setCreateModalOpen(false)
            showNotice('success', 'Topic created.')
            load()
          }}
        />
      )}

      {/* Merge modal */}
      {mergeModalOpen && selectedTags.length > 0 && (
        <MergeModal
          selectedTags={selectedTags}
          allTags={tags}
          onClose={() => setMergeModalOpen(false)}
          onMerged={() => {
            setMergeModalOpen(false)
            showNotice('success', 'Topics merged.')
            setSelected(new Set())
            load()
          }}
        />
      )}

      {/* Re-parent modal */}
      {reparentModalOpen && selectedTags.length > 0 && (
        <ReparentModal
          selectedTags={selectedTags}
          allTags={tags}
          onClose={() => setReparentModalOpen(false)}
          onDone={() => {
            setReparentModalOpen(false)
            showNotice('success', 'Topics re-parented.')
            setSelected(new Set())
            load()
          }}
        />
      )}

      {/* Re-classify confirm modal */}
      {reclassifyConfirmation && (
        <ReclassifyConfirmModal
          scope={reclassifyConfirmation.scope}
          estimate={reclassifyConfirmation.estimate}
          loading={
            !reclassifyConfirmation.estimate && !reclassifyConfirmation.error
          }
          error={reclassifyConfirmation.error}
          allTags={tags}
          onStart={handleStartReclassify}
          starting={reclassifyStarting}
          onClose={closeReclassifyConfirmation}
        />
      )}

      {/* Scoped topic picker modal */}
      {scopedModalOpen && (
        <ScopedTopicPicker
          allTags={tags}
          selectedId={scopedTopicId}
          onSelect={setScopedTopicId}
          onConfirm={confirmScopedReclassify}
          onClose={() => setScopedModalOpen(false)}
        />
      )}

      {/* Re-classify status panel */}
      {reclassifyPanelOpen && reclassifyStatus && (
        <ReclassifyPanel
          status={reclassifyStatus}
          allTags={tags}
          expandedErrors={expandedErrors}
          onToggleError={toggleErrorExpand}
          onRetryRun={handleRetryRun}
        />
      )}
    </Box>
  )
}

// ---- sub-components ----

const Stat = ({
  label,
  value,
  warn,
}: {
  label: string
  value: number
  warn?: boolean
}) => (
  <Box
    style={{
      background: warn ? '#fffbeb' : '#f7f7f7',
      border: `1px solid ${warn ? '#f6e2b3' : '#e2e8f0'}`,
      borderRadius: 8,
      padding: '6px 11px',
      fontSize: 11,
      color: warn ? '#7c3a00' : '#595959',
    }}
  >
    <Box
      as='span'
      style={{
        fontSize: 14,
        fontWeight: 700,
        color: warn ? '#7c3a00' : '#2d3748',
      }}
    >
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

// ---- Create Modal ----

const CreateTopicModal = ({
  allTags,
  onClose,
  onCreated,
}: {
  allTags: TopicRow[]
  onClose: () => void
  onCreated: () => void
}) => {
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [aliases, setAliases] = useState<string[]>([])
  const [aliasInput, setAliasInput] = useState('')
  const [parentTagId, setParentTagId] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dialogRef = useDialogBehavior(onClose, creating)

  const addAlias = () => {
    const alias = aliasInput.trim()
    if (alias && !aliases.includes(alias)) setAliases([...aliases, alias])
    setAliasInput('')
  }

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!label.trim() || creating) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valueId: label.trim(),
          description: description.trim() || null,
          aliases,
          parentTagId: parentTagId || null,
        }),
      })
      if (res.status === 401) {
        window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
        return
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) {
        setError(body.error || 'Create failed.')
        return
      }
      onCreated()
    } catch {
      setError('Network error.')
    } finally {
      setCreating(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    border: '1px solid #e2e8f0',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 12,
    fontFamily: 'inherit',
    color: '#2d3748',
  }

  return (
    <>
      <Box
        onClick={() => {
          if (!creating) onClose()
        }}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(26,54,93,0.35)',
          zIndex: 100,
        }}
      />
      <Box
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-labelledby='create-topic-title'
        tabIndex={-1}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 440,
          maxWidth: '90vw',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(26,54,93,0.30)',
          zIndex: 101,
          padding: 18,
        }}
      >
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 14,
          }}
        >
          <Heading
            id='create-topic-title'
            size='sm'
            style={{ color: '#1a365d' }}
          >
            New topic
          </Heading>
          <button
            type='button'
            aria-label='Close new topic'
            data-autofocus
            className='admin-btn'
            onClick={onClose}
            disabled={creating}
            style={{
              fontFamily: 'inherit',
              color: '#a0aec0',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: 16,
            }}
          >
            ✕
          </button>
        </Box>
        {error && (
          <Box
            style={{
              fontSize: 12,
              color: '#C11101',
              background: '#fff0f0',
              border: '1px solid #f0b4b4',
              borderRadius: 7,
              padding: '8px 12px',
              marginBottom: 12,
            }}
          >
            {error}
          </Box>
        )}
        <form onSubmit={handleCreate}>
          <Box style={{ marginBottom: 10 }}>
            <label
              style={{
                display: 'block',
                fontSize: 10,
                color: '#595959',
                marginBottom: 3,
              }}
            >
              Label
            </label>
            <input
              aria-label='Topic label'
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              style={inputStyle}
            />
          </Box>
          <Box style={{ marginBottom: 10 }}>
            <label
              style={{
                display: 'block',
                fontSize: 10,
                color: '#595959',
                marginBottom: 3,
              }}
            >
              Description
            </label>
            <textarea
              aria-label='Topic description'
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }}
            />
          </Box>
          <Box style={{ marginBottom: 10 }}>
            <label
              style={{
                display: 'block',
                fontSize: 10,
                color: '#595959',
                marginBottom: 3,
              }}
            >
              Aliases
            </label>
            {aliases.length > 0 && (
              <Box
                style={{
                  display: 'flex',
                  gap: 4,
                  flexWrap: 'wrap',
                  marginBottom: 5,
                }}
              >
                {aliases.map((alias) => (
                  <Box
                    key={alias}
                    style={{
                      fontSize: 11,
                      background: '#ebf4ff',
                      color: '#1a365d',
                      borderRadius: 999,
                      padding: '2px 8px',
                    }}
                  >
                    {alias}
                  </Box>
                ))}
              </Box>
            )}
            <Box style={{ display: 'flex', gap: 5 }}>
              <input
                placeholder='Add alias…'
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addAlias()
                  }
                }}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                type='button'
                aria-label='Add alias'
                className='admin-btn'
                onClick={addAlias}
                style={{
                  fontFamily: 'inherit',
                  fontSize: 11,
                  border: '1px solid #e2e8f0',
                  borderRadius: 6,
                  padding: '2px 9px',
                  cursor: 'pointer',
                  color: '#1a365d',
                  background: '#fff',
                }}
              >
                Add
              </button>
            </Box>
          </Box>
          <Box style={{ marginBottom: 12 }}>
            <label
              style={{
                display: 'block',
                fontSize: 10,
                color: '#595959',
                marginBottom: 3,
              }}
            >
              Parent topic
            </label>
            <select
              aria-label='Parent topic'
              value={parentTagId}
              onChange={(e) => setParentTagId(e.target.value)}
              style={inputStyle}
            >
              <option value=''>(root)</option>
              {allTags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.valueId}
                </option>
              ))}
            </select>
          </Box>
          <Box style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type='button'
              className='admin-btn'
              onClick={onClose}
              disabled={creating}
              style={{
                fontFamily: 'inherit',
                fontSize: 11,
                border: '1px solid #e2e8f0',
                borderRadius: 7,
                padding: '5px 10px',
                cursor: 'pointer',
                color: '#1a365d',
                background: '#fff',
              }}
            >
              Cancel
            </button>
            <button
              type='submit'
              className='admin-btn'
              disabled={creating || !label.trim()}
              style={{
                fontFamily: 'inherit',
                fontSize: 11,
                border: '1px solid #1a365d',
                borderRadius: 7,
                padding: '5px 10px',
                cursor: 'pointer',
                color: '#fff',
                background: '#1a365d',
                opacity: creating || !label.trim() ? 0.5 : 1,
              }}
            >
              {creating ? 'Creating…' : 'Create topic'}
            </button>
          </Box>
        </form>
      </Box>
    </>
  )
}

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
  const [drawerError, setDrawerError] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  useEscapeClose(onClose, saving)

  // Exclude self and descendants so the UI cannot offer a cyclic parent.
  const parentOptions = useMemo(() => {
    const excluded = descendantIds(allTags, [tag.id])
    excluded.add(tag.id)
    return allTags.filter((t) => !excluded.has(t.id))
  }, [allTags, tag.id])

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
    setDrawerError(null)
    try {
      const res = await fetch(`/api/admin/topics/${tag.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valueId: label !== tag.valueId ? label : undefined,
          description: description || null,
          aliases,
          parentTagId: parentTagId || null,
        }),
      })
      if (res.status === 401) {
        window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
        return
      }
      const body = await res.json().catch(() => ({}))
      if (res.status === 409 && body.error === 'cycle') {
        setParentError('Would create a cycle')
        return
      }
      if (!res.ok) {
        setDrawerError(body.error || 'Save failed')
        return
      }
      onSaved()
      onClose()
    } catch (err: any) {
      setDrawerError(err.message || 'Network error')
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
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <Heading size='sm' style={{ color: '#1a365d' }}>
            Edit topic
          </Heading>
          <button
            className='admin-btn'
            onClick={onClose}
            style={{
              fontFamily: 'inherit',
              color: '#a0aec0',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: 16,
            }}
          >
            ✕
          </button>
        </Box>

        {/* Top-of-drawer error (non-cycle errors) */}
        {drawerError && (
          <Box
            style={{
              fontSize: 11,
              color: '#C11101',
              background: '#fff0f0',
              border: '1px solid #f0b4b4',
              borderRadius: 7,
              padding: '6px 10px',
              marginBottom: 12,
            }}
          >
            {drawerError}
          </Box>
        )}

        {/* Tabs */}
        <Box
          style={{
            display: 'flex',
            gap: 14,
            borderBottom: '1px solid #e2e8f0',
            marginBottom: 12,
          }}
        >
          {(['edit', 'history', 'docs'] as const).map((t) => (
            <Box
              key={t}
              as='button'
              onClick={() => setTab(t)}
              style={{
                fontFamily: 'inherit',
                fontSize: 12,
                padding: '5px 2px',
                border: 'none',
                borderBottom:
                  tab === t ? '2px solid #1a365d' : '2px solid transparent',
                color: tab === t ? '#1a365d' : '#595959',
                fontWeight: tab === t ? 700 : 400,
                cursor: 'pointer',
                background: 'transparent',
                textTransform: 'capitalize' as const,
              }}
            >
              {t === 'docs'
                ? `Docs (${tag.acceptedCount})`
                : t === 'history'
                  ? 'History'
                  : 'Edit'}
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
                style={{
                  ...inputStyle,
                  minHeight: 50,
                  resize: 'vertical' as const,
                }}
              />
            </Box>
            <Box style={{ marginBottom: 9 }}>
              <label style={fieldLabel}>Aliases</label>
              <Box
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 4,
                  marginBottom: 4,
                }}
              >
                {aliases.map((a) => (
                  <Box
                    key={a}
                    style={{
                      fontSize: 11,
                      background: '#ebf4ff',
                      color: '#1a365d',
                      border: '1px solid #c3dafe',
                      borderRadius: 999,
                      padding: '2px 8px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    {a}
                    <button
                      className='admin-btn'
                      onClick={() => removeAlias(a)}
                      style={{
                        fontFamily: 'inherit',
                        color: '#a0aec0',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 0,
                        fontSize: 11,
                      }}
                    >
                      ✕
                    </button>
                  </Box>
                ))}
              </Box>
              <Box style={{ display: 'flex', gap: 4 }}>
                <input
                  value={aliasInput}
                  onChange={(e) => setAliasInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addAlias()
                    }
                  }}
                  placeholder='Add alias…'
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  className='admin-btn'
                  onClick={addAlias}
                  style={{
                    fontFamily: 'inherit',
                    fontSize: 11,
                    border: '1px solid #e2e8f0',
                    borderRadius: 6,
                    padding: '2px 8px',
                    cursor: 'pointer',
                    color: '#1a365d',
                    background: '#fff',
                  }}
                >
                  Add
                </button>
              </Box>
            </Box>
            <Box style={{ marginBottom: 9 }}>
              <label style={fieldLabel}>Parent topic</label>
              <select
                aria-label='Parent topic'
                value={parentTagId}
                onChange={(e) => {
                  setParentTagId(e.target.value)
                  setParentError(null)
                  setDrawerError(null)
                }}
                style={inputStyle}
              >
                <option value=''>(root)</option>
                {parentOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.valueId}
                  </option>
                ))}
              </select>
              {parentError && (
                <Box style={{ fontSize: 11, color: '#C11101', marginTop: 3 }}>
                  {parentError}
                </Box>
              )}
            </Box>
            {/* Save / Cancel */}
            <Box
              style={{
                display: 'flex',
                gap: 7,
                justifyContent: 'flex-end',
                marginTop: 12,
              }}
            >
              <button
                className='admin-btn'
                onClick={onClose}
                style={{
                  fontFamily: 'inherit',
                  fontSize: 11,
                  border: '1px solid #e2e8f0',
                  borderRadius: 7,
                  padding: '5px 10px',
                  cursor: 'pointer',
                  color: '#1a365d',
                  background: '#fff',
                }}
              >
                Cancel
              </button>
              <button
                className='admin-btn'
                onClick={handleSave}
                disabled={saving}
                style={{
                  fontFamily: 'inherit',
                  fontSize: 11,
                  border: '1px solid #1a365d',
                  borderRadius: 7,
                  padding: '5px 10px',
                  cursor: 'pointer',
                  color: '#fff',
                  background: '#1a365d',
                  opacity: saving ? 0.5 : 1,
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </Box>
          </Box>
        )}

        {/* History tab */}
        {tab === 'history' && (
          <Box>
            {historyLoading ? (
              <Text style={{ color: '#595959', fontSize: 12 }}>
                Loading history…
              </Text>
            ) : history.length === 0 ? (
              <Text style={{ color: '#595959', fontSize: 12 }}>
                No history entries.
              </Text>
            ) : (
              history.map((entry, i) => (
                <Box
                  key={i}
                  style={{
                    padding: '8px 0',
                    borderBottom: '1px solid #edf2f7',
                  }}
                >
                  <Box
                    style={{ fontSize: 12, fontWeight: 600, color: '#1a365d' }}
                  >
                    {entry.action}
                  </Box>
                  <Box style={{ fontSize: 11, color: '#595959' }}>
                    {entry.actor} · {new Date(entry.at).toLocaleDateString()}
                  </Box>
                  {entry.before && (
                    <Box
                      style={{ fontSize: 11, color: '#718096', marginTop: 2 }}
                    >
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

// ---- MergeModal ----

const MergeModal = ({
  selectedTags,
  allTags,
  onClose,
  onMerged,
}: {
  selectedTags: TopicRow[]
  allTags: TopicRow[]
  onClose: () => void
  onMerged: () => void
}) => {
  const [targetId, setTargetId] = useState('')
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dialogRef = useDialogBehavior(onClose, merging)

  // All topics are candidates for the target (including selected — the target
  // is skipped in the merge loop, so it survives as the survivor).
  const targetOptions = allTags
  const sources = selectedTags.filter((t) => t.id !== targetId)
  const target = allTags.find((t) => t.id === targetId)

  const handleMerge = async () => {
    if (!targetId || sources.length === 0) return
    setMerging(true)
    setError(null)
    try {
      for (const source of sources) {
        const res = await fetch(`/api/admin/topics/${source.id}/merge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ intoTagId: targetId }),
        })
        if (res.status === 401) {
          // eslint-disable-next-line react-hooks/immutability
          window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
          return
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          setError(body.error || 'Merge failed')
          return
        }
      }
      onMerged()
    } catch (err: any) {
      setError(err.message || 'Network error')
    } finally {
      setMerging(false)
    }
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
      <Box
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-labelledby='merge-topics-title'
        tabIndex={-1}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 420,
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(26,54,93,0.30)',
          zIndex: 101,
          padding: 18,
        }}
      >
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 14,
          }}
        >
          <Heading
            id='merge-topics-title'
            size='sm'
            style={{ color: '#1a365d' }}
          >
            Merge {selectedTags.length} topic
            {selectedTags.length !== 1 ? 's' : ''}
          </Heading>
          <button
            className='admin-btn'
            aria-label='Close merge topics'
            data-autofocus
            onClick={onClose}
            disabled={merging}
            style={{
              fontFamily: 'inherit',
              color: '#a0aec0',
              background: 'transparent',
              border: 'none',
              cursor: merging ? 'not-allowed' : 'pointer',
              fontSize: 16,
            }}
          >
            ✕
          </button>
        </Box>

        {error && (
          <Box
            style={{
              fontSize: 11,
              color: '#C11101',
              background: '#fff0f0',
              border: '1px solid #f0b4b4',
              borderRadius: 7,
              padding: '6px 10px',
              marginBottom: 12,
            }}
          >
            {error}
          </Box>
        )}

        {/* Selected topics */}
        <Box style={{ marginBottom: 12 }}>
          <label
            style={{
              display: 'block',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: '#595959',
              marginBottom: 3,
            }}
          >
            Selected topics
          </label>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {selectedTags.map((t) => (
              <Box
                key={t.id}
                style={{
                  fontSize: 12,
                  color: '#2d3748',
                  background: '#ebf4ff',
                  border: '1px solid #c3dafe',
                  borderRadius: 999,
                  padding: '4px 10px',
                  alignSelf: 'flex-start',
                }}
              >
                {t.valueId}
              </Box>
            ))}
          </Box>
        </Box>

        {/* Target picker */}
        <Box style={{ marginBottom: 12 }}>
          <label
            style={{
              display: 'block',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: '#595959',
              marginBottom: 3,
            }}
          >
            Merge all into
          </label>
          <select
            value={targetId}
            onChange={(e) => {
              setTargetId(e.target.value)
              setError(null)
            }}
            style={inputStyle}
          >
            <option value=''>— select target —</option>
            {targetOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.valueId} ({t.acceptedCount} docs)
              </option>
            ))}
          </select>
        </Box>

        {/* Preview */}
        {targetId && sources.length > 0 && (
          <Box
            style={{
              background: '#f7f7f7',
              border: '1px solid #e2e8f0',
              borderRadius: 8,
              padding: '10px 13px',
              marginBottom: 12,
            }}
          >
            <Box
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: '#1a365d',
                marginBottom: 6,
              }}
            >
              Preview
            </Box>
            {sources.map((s) => (
              <Box
                key={s.id}
                style={{ fontSize: 12, color: '#2d3748', lineHeight: 1.6 }}
              >
                <strong>{s.valueId}</strong> →{' '}
                <strong>{target?.valueId}</strong> · {s.acceptedCount} docs move
              </Box>
            ))}
            <Box style={{ fontSize: 11, color: '#7c3a00', marginTop: 6 }}>
              {sources.length} tag{sources.length !== 1 ? 's' : ''} will be
              deleted; aliases merged into {target?.valueId}.
            </Box>
          </Box>
        )}

        {/* Buttons */}
        <Box style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            className='admin-btn'
            onClick={onClose}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #e2e8f0',
              borderRadius: 7,
              padding: '5px 10px',
              cursor: 'pointer',
              color: '#1a365d',
              background: '#fff',
            }}
          >
            Cancel
          </button>
          <button
            className='admin-btn'
            onClick={handleMerge}
            disabled={merging || !targetId || sources.length === 0}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #1a365d',
              borderRadius: 7,
              padding: '5px 10px',
              cursor: 'pointer',
              color: '#fff',
              background: '#1a365d',
              opacity: merging || !targetId || sources.length === 0 ? 0.5 : 1,
            }}
          >
            {merging ? 'Merging…' : 'Merge & re-classify'}
          </button>
        </Box>
      </Box>
    </>
  )
}

// ---- ReparentModal ----

const ReparentModal = ({
  selectedTags,
  allTags,
  onClose,
  onDone,
}: {
  selectedTags: TopicRow[]
  allTags: TopicRow[]
  onClose: () => void
  onDone: () => void
}) => {
  const [parentTagId, setParentTagId] = useState('')
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<{ label: string; reason: string }[]>([])

  const dialogRef = useDialogBehavior(onClose, saving)

  // Exclude selected subtrees so no selected topic can become its own ancestor.
  const parentOptions = useMemo(() => {
    const selectedIds = selectedTags.map((tag) => tag.id)
    const excluded = descendantIds(allTags, selectedIds)
    for (const id of selectedIds) excluded.add(id)
    return allTags.filter((tag) => !excluded.has(tag.id))
  }, [allTags, selectedTags])

  const handleReparent = async () => {
    setSaving(true)
    setErrors([])
    const failures: { label: string; reason: string }[] = []
    for (const tag of selectedTags) {
      try {
        const res = await fetch(`/api/admin/topics/${tag.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parentTagId: parentTagId || null }),
        })
        if (res.status === 401) {
          window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
          return
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          failures.push({ label: tag.valueId, reason: body.error || 'failed' })
        }
      } catch {
        failures.push({ label: tag.valueId, reason: 'network error' })
      }
    }
    setSaving(false)
    if (failures.length === 0) {
      onDone()
    } else {
      setErrors(failures)
    }
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
      <Box
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-labelledby='reparent-topics-title'
        tabIndex={-1}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 380,
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(26,54,93,0.30)',
          zIndex: 101,
          padding: 18,
        }}
      >
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 14,
          }}
        >
          <Heading
            id='reparent-topics-title'
            size='sm'
            style={{ color: '#1a365d' }}
          >
            Re-parent {selectedTags.length} topic
            {selectedTags.length !== 1 ? 's' : ''}
          </Heading>
          <button
            className='admin-btn'
            aria-label='Close re-parent topics'
            data-autofocus
            onClick={onClose}
            disabled={saving}
            style={{
              fontFamily: 'inherit',
              color: '#a0aec0',
              background: 'transparent',
              border: 'none',
              cursor: saving ? 'not-allowed' : 'pointer',
              fontSize: 16,
            }}
          >
            ✕
          </button>
        </Box>

        {errors.length > 0 && (
          <Box
            style={{
              fontSize: 11,
              color: '#C11101',
              background: '#fff0f0',
              border: '1px solid #f0b4b4',
              borderRadius: 7,
              padding: '6px 10px',
              marginBottom: 12,
            }}
          >
            {errors.map((e, i) => (
              <Box key={i} style={{ marginBottom: 2 }}>
                {e.label}: {e.reason}
              </Box>
            ))}
          </Box>
        )}

        <Box style={{ marginBottom: 12 }}>
          <label
            style={{
              display: 'block',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: '#595959',
              marginBottom: 3,
            }}
          >
            New parent topic
          </label>
          <select
            value={parentTagId}
            onChange={(e) => {
              setParentTagId(e.target.value)
              setErrors([])
            }}
            style={inputStyle}
          >
            <option value=''>(root)</option>
            {parentOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.valueId}
              </option>
            ))}
          </select>
        </Box>

        <Box style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            className='admin-btn'
            onClick={onClose}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #e2e8f0',
              borderRadius: 7,
              padding: '5px 10px',
              cursor: 'pointer',
              color: '#1a365d',
              background: '#fff',
            }}
          >
            Cancel
          </button>
          <button
            className='admin-btn'
            onClick={handleReparent}
            disabled={saving}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #1a365d',
              borderRadius: 7,
              padding: '5px 10px',
              cursor: 'pointer',
              color: '#fff',
              background: '#1a365d',
              opacity: saving ? 0.5 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Re-parent'}
          </button>
        </Box>
      </Box>
    </>
  )
}

// ---- CSV Import Modal (Task 16) ----

interface CsvDiffData {
  added: {
    label: string
    description: string
    aliases: string[]
    parent: string
    facet: string
    id: string
  }[]
  updated: {
    row: {
      label: string
      description: string
      aliases: string[]
      parent: string
      facet: string
      id: string
    }
    current: any
  }[]
  unchanged: {
    label: string
    description: string
    aliases: string[]
    parent: string
    facet: string
    id: string
  }[]
  conflicts: {
    row: {
      label: string
      description: string
      aliases: string[]
      parent: string
      facet: string
      id: string
    }
    reason: string
  }[]
}

const CsvImportModal = ({
  diff,
  loading,
  error,
  reclassify,
  applying,
  filename,
  onReclassifyChange,
  onApply,
  onClose,
}: {
  diff: CsvDiffData | null
  loading: boolean
  error: string | null
  reclassify: boolean
  applying: boolean
  filename: string
  onReclassifyChange: (v: boolean) => void
  onApply: () => void
  onClose: () => void
}) => {
  const addedCount = diff?.added.length ?? 0
  const updatedCount = diff?.updated.length ?? 0
  const unchangedCount = diff?.unchanged.length ?? 0
  const conflictCount = diff?.conflicts.length ?? 0
  const totalChanges = addedCount + updatedCount
  const canApply = conflictCount === 0 && totalChanges > 0 && !applying

  const dialogRef = useDialogBehavior(onClose, applying || loading)

  return (
    <>
      <Box
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(26,54,93,0.35)',
          zIndex: 100,
        }}
        onClick={onClose}
      />
      <Box
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-labelledby='csv-import-title'
        tabIndex={-1}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 560,
          maxWidth: '90vw',
          maxHeight: '80vh',
          overflow: 'auto',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(26,54,93,0.30)',
          zIndex: 101,
          padding: 18,
        }}
      >
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 14,
          }}
        >
          <Heading id='csv-import-title' size='sm' style={{ color: '#1a365d' }}>
            Import CSV{filename ? ` — ${filename}` : ''}
          </Heading>
          <button
            className='admin-btn'
            aria-label='Close CSV import'
            data-autofocus
            onClick={onClose}
            style={{
              fontFamily: 'inherit',
              color: '#a0aec0',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: 16,
            }}
          >
            ✕
          </button>
        </Box>

        {loading && (
          <Text style={{ color: '#595959', padding: '20px 0' }}>
            Parsing CSV…
          </Text>
        )}

        {error && (
          <Box
            style={{
              fontSize: 12,
              color: '#C11101',
              background: '#fff0f0',
              border: '1px solid #f0b4b4',
              borderRadius: 7,
              padding: '8px 12px',
              marginBottom: 12,
            }}
          >
            {error}
          </Box>
        )}

        {diff && (
          <>
            {/* Summary chips */}
            <Box
              style={{
                display: 'flex',
                gap: 8,
                marginBottom: 14,
                flexWrap: 'wrap',
              }}
            >
              <Box
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  border: '1px solid #c6f6d5',
                  background: '#f0fff4',
                  color: '#2f855a',
                  borderRadius: 999,
                  padding: '4px 11px',
                }}
              >
                {addedCount} added
              </Box>
              <Box
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  border: '1px solid #f6e2b3',
                  background: '#fffaf0',
                  color: '#7c3a00',
                  borderRadius: 999,
                  padding: '4px 11px',
                }}
              >
                {updatedCount} updated
              </Box>
              <Box
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  border: '1px solid #e2e8f0',
                  background: '#fff',
                  color: '#595959',
                  borderRadius: 999,
                  padding: '4px 11px',
                }}
              >
                {unchangedCount} unchanged
              </Box>
              <Box
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  border: '1px solid #f0b4b4',
                  background: '#fff0f0',
                  color: '#C11101',
                  borderRadius: 999,
                  padding: '4px 11px',
                }}
              >
                {conflictCount} {conflictCount === 1 ? 'conflict' : 'conflicts'}
              </Box>
            </Box>

            {/* Diff table */}
            <Box
              style={{
                border: '1px solid #e2e8f0',
                borderRadius: 10,
                overflow: 'hidden',
                maxHeight: 300,
                overflowY: 'auto',
              }}
            >
              {/* Added rows */}
              {diff.added.map((r, i) => (
                <Box
                  key={`add-${i}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '64px 1fr',
                    padding: '8px 12px',
                    borderBottom: '1px solid #edf2f7',
                    background: '#f0fff4',
                  }}
                >
                  <Box
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      color: '#2f855a',
                      background: '#c6f6d5',
                      borderRadius: 5,
                      padding: '2px 7px',
                      display: 'inline-block',
                      textAlign: 'center',
                      height: 'fit-content',
                    }}
                  >
                    Add
                  </Box>
                  <Box>
                    <Box
                      style={{
                        fontWeight: 600,
                        color: '#2d3748',
                        fontSize: 13,
                      }}
                    >
                      {r.label}
                    </Box>
                    {r.description && (
                      <Box style={{ color: '#718096', fontSize: 11 }}>
                        desc: {r.description}
                      </Box>
                    )}
                    {r.aliases.length > 0 && (
                      <Box style={{ color: '#718096', fontSize: 11 }}>
                        aliases: {r.aliases.join(' | ')}
                      </Box>
                    )}
                  </Box>
                </Box>
              ))}
              {/* Updated rows */}
              {diff.updated.map((u, i) => (
                <Box
                  key={`upd-${i}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '64px 1fr',
                    padding: '8px 12px',
                    borderBottom: '1px solid #edf2f7',
                    background: '#fffaf0',
                  }}
                >
                  <Box
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      color: '#7c3a00',
                      background: '#f6e2b3',
                      borderRadius: 5,
                      padding: '2px 7px',
                      display: 'inline-block',
                      textAlign: 'center',
                      height: 'fit-content',
                    }}
                  >
                    Edit
                  </Box>
                  <Box>
                    <Box
                      style={{
                        fontWeight: 600,
                        color: '#2d3748',
                        fontSize: 13,
                      }}
                    >
                      {u.row.label}
                    </Box>
                    {u.row.description && (
                      <Box style={{ color: '#718096', fontSize: 11 }}>
                        desc: {u.row.description}
                      </Box>
                    )}
                    {u.row.aliases.length > 0 && (
                      <Box style={{ color: '#718096', fontSize: 11 }}>
                        aliases: {u.row.aliases.join(' | ')}
                      </Box>
                    )}
                  </Box>
                </Box>
              ))}
              {/* Conflict rows */}
              {diff.conflicts.map((c, i) => (
                <Box
                  key={`con-${i}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '64px 1fr',
                    padding: '8px 12px',
                    borderBottom: '1px solid #edf2f7',
                    background: '#fff0f0',
                  }}
                >
                  <Box
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      color: '#C11101',
                      background: '#fbd5d5',
                      borderRadius: 5,
                      padding: '2px 7px',
                      display: 'inline-block',
                      textAlign: 'center',
                      height: 'fit-content',
                    }}
                  >
                    Conflict
                  </Box>
                  <Box>
                    <Box
                      style={{
                        fontWeight: 600,
                        color: '#2d3748',
                        fontSize: 13,
                      }}
                    >
                      {c.row.label}
                    </Box>
                    <Box style={{ color: '#C11101', fontSize: 11 }}>
                      {c.reason}
                    </Box>
                  </Box>
                </Box>
              ))}
            </Box>

            {/* Footer */}
            <Box
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 14,
                flexWrap: 'wrap',
                gap: 10,
              }}
            >
              <Box style={{ fontSize: 12, color: '#595959' }}>
                {conflictCount > 0
                  ? `Resolve ${conflictCount} conflict${conflictCount !== 1 ? 's' : ''} before applying. Nothing is applied until conflicts = 0.`
                  : 'Import commits atomically — all or nothing.'}
              </Box>
              <Box style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Box
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    color: '#2d3748',
                    background: '#fff',
                    border: '1px solid #e2e8f0',
                    borderRadius: 7,
                    padding: '5px 10px',
                  }}
                >
                  <input
                    type='checkbox'
                    checked={reclassify}
                    onChange={(e) => onReclassifyChange(e.target.checked)}
                    style={{ accentColor: '#1a365d' }}
                  />
                  Re-classify affected docs
                </Box>
                <button
                  className='admin-btn'
                  onClick={onClose}
                  style={{
                    fontFamily: 'inherit',
                    fontSize: 11,
                    border: '1px solid #e2e8f0',
                    borderRadius: 7,
                    padding: '5px 10px',
                    cursor: 'pointer',
                    color: '#1a365d',
                    background: '#fff',
                  }}
                >
                  Cancel
                </button>
                <button
                  className='admin-btn'
                  onClick={onApply}
                  disabled={!canApply}
                  style={{
                    fontFamily: 'inherit',
                    fontSize: 11,
                    border: canApply
                      ? '1px solid #1a365d'
                      : '1px solid #a0aec0',
                    borderRadius: 7,
                    padding: '5px 10px',
                    cursor: canApply ? 'pointer' : 'not-allowed',
                    color: '#fff',
                    background: canApply ? '#1a365d' : '#a0aec0',
                    opacity: applying ? 0.5 : 1,
                  }}
                >
                  {applying
                    ? 'Applying…'
                    : `Apply ${totalChanges} change${totalChanges !== 1 ? 's' : ''}`}
                </button>
              </Box>
            </Box>
          </>
        )}
      </Box>
    </>
  )
}

// ---- Reclassify confirm modal ----

const ReclassifyConfirmModal = ({
  scope,
  estimate,
  loading,
  error,
  allTags,
  onStart,
  starting,
  onClose,
}: {
  scope: 'all' | string
  estimate: { eligible: number; estCost: number } | null
  loading: boolean
  error: string | null
  allTags: TopicRow[]
  onStart: () => void
  starting: boolean
  onClose: () => void
}) => {
  const scopeLabel =
    scope === 'all'
      ? 'All docs'
      : `Topic: ${allTags.find((t) => t.id === scope)?.valueId ?? scope}`
  const canStart = Boolean(estimate && estimate.eligible > 0 && !starting)

  const dialogRef = useDialogBehavior(onClose, starting)

  return (
    <>
      <Box
        data-testid='reclassify-backdrop'
        onClick={() => {
          if (!starting) onClose()
        }}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          background: 'rgba(26,54,93,0.35)',
          zIndex: 100,
        }}
      />
      <Box
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-labelledby='reclassify-confirm-title'
        tabIndex={-1}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 440,
          maxWidth: '90vw',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(26,54,93,0.30)',
          zIndex: 101,
          padding: 18,
        }}
      >
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 14,
          }}
        >
          <Heading
            id='reclassify-confirm-title'
            size='sm'
            style={{ color: '#1a365d' }}
          >
            Re-classify: {scopeLabel}
          </Heading>
          <button
            className='admin-btn'
            aria-label='Close re-classification confirmation'
            data-autofocus
            onClick={onClose}
            disabled={starting}
            style={{
              fontFamily: 'inherit',
              fontSize: 14,
              color: '#a0aec0',
              background: 'transparent',
              border: 'none',
              cursor: starting ? 'not-allowed' : 'pointer',
            }}
          >
            ✕
          </button>
        </Box>

        {loading && (
          <Text style={{ color: '#595959', fontSize: 13 }}>Estimating…</Text>
        )}
        {error && (
          <Box
            style={{
              padding: '8px 12px',
              marginBottom: 10,
              color: '#C11101',
              background: '#fff0f0',
              border: '1px solid #f0b4b4',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            {error}
          </Box>
        )}
        {estimate && (
          <>
            <Box style={{ fontSize: 13, color: '#2d3748', marginBottom: 8 }}>
              Re-classify <b>{estimate.eligible}</b> docs? Estimated cost:{' '}
              <b>≈${estimate.estCost.toFixed(4)}</b>.
            </Box>
            <Box style={{ fontSize: 12, color: '#595959', marginBottom: 14 }}>
              Each doc gets one LLM call (gpt-5-mini, topic-only). Human
              overrides are preserved.
            </Box>
          </>
        )}

        <Box style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            className='admin-btn'
            onClick={onClose}
            disabled={starting}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #e2e8f0',
              borderRadius: 7,
              padding: '5px 11px',
              cursor: starting ? 'not-allowed' : 'pointer',
              color: '#1a365d',
              background: '#fff',
            }}
          >
            Cancel
          </button>
          <button
            className='admin-btn'
            onClick={onStart}
            disabled={!canStart}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: canStart ? '1px solid #1a365d' : '1px solid #a0aec0',
              borderRadius: 7,
              padding: '5px 11px',
              cursor: canStart ? 'pointer' : 'not-allowed',
              color: '#fff',
              background: canStart ? '#1a365d' : '#a0aec0',
            }}
          >
            {starting ? 'Starting…' : 'Start'}
          </button>
        </Box>
      </Box>
    </>
  )
}

// ---- Scoped topic picker ----

const ScopedTopicPicker = ({
  allTags,
  selectedId,
  onSelect,
  onConfirm,
  onClose,
}: {
  allTags: TopicRow[]
  selectedId: string
  onSelect: (id: string) => void
  onConfirm: () => void
  onClose: () => void
}) => {
  const dialogRef = useDialogBehavior(onClose)

  return (
    <>
      <Box
        onClick={onClose}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          background: 'rgba(26,54,93,0.35)',
          zIndex: 100,
        }}
      />
      <Box
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-labelledby='scoped-reclassify-title'
        tabIndex={-1}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 380,
          maxWidth: '90vw',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(26,54,93,0.30)',
          zIndex: 101,
          padding: 18,
        }}
      >
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 14,
          }}
        >
          <Heading
            id='scoped-reclassify-title'
            size='sm'
            style={{ color: '#1a365d' }}
          >
            Scoped re-classify
          </Heading>
          <button
            className='admin-btn'
            aria-label='Close scoped re-classify'
            data-autofocus
            onClick={onClose}
            style={{
              fontFamily: 'inherit',
              fontSize: 14,
              color: '#a0aec0',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </Box>
        <Box style={{ marginBottom: 10 }}>
          <label
            style={{
              display: 'block',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: '#595959',
              marginBottom: 3,
            }}
          >
            Pick a topic
          </label>
          <select
            aria-label='Pick a topic'
            value={selectedId}
            onChange={(e) => onSelect(e.target.value)}
            style={{
              width: '100%',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
              padding: '6px 8px',
              fontSize: 12,
              fontFamily: 'inherit',
              color: '#2d3748',
            }}
          >
            <option value=''>— select a topic —</option>
            {allTags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.valueId} ({t.acceptedCount} docs)
              </option>
            ))}
          </select>
        </Box>
        <Box style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            className='admin-btn'
            onClick={onClose}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: '1px solid #e2e8f0',
              borderRadius: 7,
              padding: '5px 11px',
              cursor: 'pointer',
              color: '#1a365d',
              background: '#fff',
            }}
          >
            Cancel
          </button>
          <button
            className='admin-btn'
            onClick={onConfirm}
            disabled={!selectedId}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              border: selectedId ? '1px solid #1a365d' : '1px solid #a0aec0',
              borderRadius: 7,
              padding: '5px 11px',
              cursor: selectedId ? 'pointer' : 'not-allowed',
              color: '#fff',
              background: selectedId ? '#1a365d' : '#a0aec0',
            }}
          >
            Confirm
          </button>
        </Box>
      </Box>
    </>
  )
}

// ---- Reclassify status panel ----

const ReclassifyPanel = ({
  status,
  allTags,
  expandedErrors,
  onToggleError,
  onRetryRun,
}: {
  status: {
    queued: number
    running: number
    done: number
    error: number
    recent: {
      runId: string
      scope: 'all' | string
      total: number
      done: number
      error: number
      estCost: number
      createdAt: string
      updatedAt?: string
      errors?: {
        documentId: string
        externalId: string
        title: string | null
        attempts: number
        error: string | null
      }[]
    }[]
  }
  allTags: TopicRow[]
  expandedErrors: Set<string>
  onToggleError: (runId: string) => void
  onRetryRun: (runId: string) => void
}) => {
  const activeRun = status.recent[0]
  const totalActive = activeRun ? activeRun.total : 0
  const doneActive = activeRun ? activeRun.done : 0
  const pct = totalActive > 0 ? Math.round((doneActive / totalActive) * 100) : 0

  return (
    <Box
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 12,
        overflow: 'hidden',
        marginBottom: 12,
      }}
    >
      {/* Panel header */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          background: '#f7f7f7',
          borderBottom: '1px solid #e2e8f0',
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {(status.queued > 0 || status.running > 0) && (
            <Box
              style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: '#3182ce',
              }}
            />
          )}
          <Heading size='sm' style={{ color: '#1a365d' }}>
            Re-classify jobs
          </Heading>
        </Box>
        <Box style={{ fontSize: 11, color: '#595959' }}>Auto-refresh 5s</Box>
      </Box>

      <Box style={{ padding: 16 }}>
        {/* Live progress */}
        {activeRun && (status.queued > 0 || status.running > 0) && (
          <Box
            style={{
              background: '#ebf4ff',
              border: '1px solid #c3e2f7',
              borderRadius: 9,
              padding: '14px 16px',
              marginBottom: 16,
            }}
          >
            <Box
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: 9,
              }}
            >
              <Box style={{ fontSize: 13, fontWeight: 700, color: '#3182ce' }}>
                {activeRun.scope === 'all'
                  ? 'Full corpus'
                  : `Scoped: ${allTags.find((t) => t.id === activeRun.scope)?.valueId ?? activeRun.scope}`}{' '}
                · in progress
              </Box>
              <Box style={{ fontSize: 13, color: '#2d3748' }}>
                <b>{doneActive}</b> / {totalActive} docs · {pct}%
              </Box>
            </Box>
            {/* Progress bar */}
            <Box
              style={{
                height: 10,
                background: '#fff',
                borderRadius: 999,
                overflow: 'hidden',
                border: '1px solid #c3e2f7',
              }}
            >
              <Box
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg, #3182ce, #63b3ed)',
                  borderRadius: 999,
                  transition: 'width 0.5s',
                }}
              />
            </Box>
            <Box
              style={{
                display: 'flex',
                gap: 14,
                marginTop: 8,
                fontSize: 11,
                color: '#595959',
                flexWrap: 'wrap',
              }}
            >
              <span>
                est. cost <b>${activeRun.estCost.toFixed(4)}</b>
              </span>
              {status.error > 0 && (
                <span style={{ color: '#C11101' }}>
                  {status.error} error{status.error !== 1 ? 's' : ''}
                </span>
              )}
            </Box>
          </Box>
        )}

        {/* Recent runs */}
        {status.recent.length > 0 && (
          <>
            <Box
              style={{
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: '#595959',
                marginBottom: 8,
              }}
            >
              Recent runs
            </Box>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {status.recent.map((run) => {
                const scopeLabel =
                  run.scope === 'all'
                    ? 'Full corpus'
                    : `Scoped: ${allTags.find((t) => t.id === run.scope)?.valueId ?? run.scope}`
                const isExpanded = expandedErrors.has(run.runId)
                return (
                  <Box
                    key={run.runId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      flexWrap: 'wrap',
                      border: '1px solid #edf2f7',
                      borderRadius: 9,
                      padding: '10px 12px',
                    }}
                  >
                    <Box
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 14,
                        flex: '0 0 30px',
                        background: run.scope === 'all' ? '#ebf4ff' : '#f0fff4',
                        color: run.scope === 'all' ? '#3182ce' : '#2f855a',
                      }}
                    >
                      {run.scope === 'all' ? '∞' : '⌖'}
                    </Box>
                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <Box
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: '#2d3748',
                        }}
                      >
                        {scopeLabel}
                      </Box>
                      <Box
                        style={{ fontSize: 11, color: '#595959', marginTop: 1 }}
                      >
                        {run.done}/{run.total} docs
                        {run.error > 0 && (
                          <span style={{ color: '#C11101' }}>
                            {' '}
                            · {run.error} error{run.error !== 1 ? 's' : ''}
                          </span>
                        )}
                      </Box>
                    </Box>
                    <Box
                      style={{
                        textAlign: 'right',
                        fontSize: 11,
                        color: '#595959',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <b style={{ color: '#2d3748' }}>
                        ${run.estCost.toFixed(4)}
                      </b>
                      <br />
                      <span style={{ fontSize: 10, color: '#718096' }}>
                        {new Date(run.createdAt).toLocaleString()}
                      </span>
                    </Box>
                    {run.error > 0 && (
                      <button
                        className='admin-btn'
                        onClick={() => onToggleError(run.runId)}
                        style={{
                          fontFamily: 'inherit',
                          fontSize: 10,
                          border: '1px solid #f0b4b4',
                          borderRadius: 999,
                          padding: '2px 8px',
                          cursor: 'pointer',
                          color: '#C11101',
                          background: '#fff0f0',
                          fontWeight: 600,
                        }}
                      >
                        {isExpanded
                          ? 'Hide'
                          : `${run.error} error${run.error !== 1 ? 's' : ''}`}
                      </button>
                    )}
                    {run.error > 0 && isExpanded && (
                      <Box
                        style={{
                          width: '100%',
                          padding: '8px 10px',
                          background: '#fff0f0',
                          border: '1px solid #f0b4b4',
                          borderRadius: 8,
                          fontSize: 11,
                          color: '#C11101',
                        }}
                      >
                        <Box
                          style={{ display: 'flex', gap: 6, padding: '2px 0' }}
                        >
                          <Box style={{ fontWeight: 600 }}>
                            {run.error} failed doc{run.error !== 1 ? 's' : ''}
                          </Box>
                          <button
                            className='admin-btn'
                            onClick={() => onRetryRun(run.runId)}
                            style={{
                              fontFamily: 'inherit',
                              color: '#1a365d',
                              textDecoration: 'underline',
                              cursor: 'pointer',
                              background: 'transparent',
                              border: 'none',
                            }}
                          >
                            Retry
                          </button>
                        </Box>
                        {(run.errors ?? []).map((detail) => (
                          <Box
                            key={detail.documentId}
                            style={{
                              marginTop: 6,
                              paddingTop: 6,
                              borderTop: '1px solid #f0b4b4',
                            }}
                          >
                            <Box style={{ fontWeight: 600 }}>
                              {detail.title ??
                                detail.externalId ??
                                detail.documentId}
                            </Box>
                            <Box>
                              {detail.externalId} · attempts: {detail.attempts}
                            </Box>
                            <Box>{detail.error ?? 'Unknown error'}</Box>
                          </Box>
                        ))}
                      </Box>
                    )}
                  </Box>
                )
              })}
            </Box>
          </>
        )}

        {/* Empty state */}
        {status.recent.length === 0 &&
          status.queued + status.running + status.done + status.error === 0 && (
            <Text style={{ color: '#595959', fontSize: 12 }}>
              No re-classify jobs yet.
            </Text>
          )}
      </Box>
    </Box>
  )
}
