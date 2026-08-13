'use client'

import { useCallback, useEffect, useState } from 'react'
import { Box, Heading, Text } from '@chakra-ui/react'
import { adminFetch } from '../lib/api'
import { actionButton } from '../lib/buttonStyles'
import { StatusChip } from './StatusChip'
import { Flash } from './Flash'

interface RelationDoc {
  externalId: string
  title: string | null
  language: string | null
}

interface RelationRow {
  id: string
  documentId: string
  relatedDocumentId: string
  relationType: string
  status: string
  source: string
  confidence: number | null
  signals: Record<string, any>
  createdAt: string
  reviewedBy: string | null
  reviewedAt: string | null
  translation: RelationDoc
  original: RelationDoc
}

const ORPHAN_NOTE =
  'Withdrawing this document also removes its linked translation from results (the pair is one work).'

const SignalChips = ({ signals }: { signals: Record<string, any> }) => {
  const parts: string[] = []
  if (typeof signals.title_similarity === 'number')
    parts.push(`title ${signals.title_similarity}`)
  if (typeof signals.embedding_similarity === 'number')
    parts.push(`embed ${signals.embedding_similarity}`)
  if (Array.isArray(signals.language_disagreement) && signals.language_disagreement.length)
    parts.push('language mismatch')
  if (parts.length === 0) return null
  return <span>{parts.join(' · ')}</span>
}

/**
 * RelationsPanel — translation-pair review surface (issue #325).
 *
 * - Without `docId` (review queue): lists every pending system suggestion with
 *   confirm / reject / flip actions, plus confirmed pairs with Unlink.
 * - With `docId` (document page): filtered to that doc's relations, adds a
 *   manual-link form, and shows an orphan warning when the doc is the original
 *   of a confirmed edge (withdrawing it also removes its translation).
 *
 * Only confirmed edges affect retrieval; suggestions are advisory. The flag
 * (`translation_pairs_enabled`) is OFF by default — confirming a pair changes
 * nothing until ops enables it (eval-gated, see the runbook).
 */
export const RelationsPanel = ({ docId }: { docId?: string } = {}) => {
  const [relations, setRelations] = useState<RelationRow[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [linkExt, setLinkExt] = useState('')
  const [linkMode, setLinkMode] = useState<'translation' | 'original'>(
    'translation',
  )

  const load = useCallback(async () => {
    try {
      const [suggested, confirmed] = await Promise.all([
        adminFetch<{ relations: RelationRow[] }>(
          '/api/admin/relations?status=suggested',
        ),
        adminFetch<{ relations: RelationRow[] }>(
          '/api/admin/relations?status=confirmed',
        ),
      ])
      let rows = [...suggested.relations, ...confirmed.relations]
      if (docId) {
        rows = rows.filter(
          (r) => r.documentId === docId || r.relatedDocumentId === docId,
        )
      }
      setRelations(rows)
      setError(null)
    } catch (err: any) {
      setError(err.message)
    }
  }, [docId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const act = async (
    id: string,
    action: 'confirm' | 'reject' | 'flip' | 'unlink',
  ) => {
    setBusyId(id)
    setNotice(null)
    setError(null)
    try {
      await adminFetch(`/api/admin/relations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      })
      setNotice(
        action === 'confirm'
          ? 'Pair confirmed.'
          : action === 'reject'
            ? 'Marked not a pair.'
            : action === 'flip'
              ? 'Direction flipped.'
              : 'Unlinked.',
      )
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const submitLink = async () => {
    setNotice(null)
    setError(null)
    const ext = linkExt.trim()
    if (!ext) {
      setError('Enter an external id.')
      return
    }
    if (!docId) return
    try {
      const body = await adminFetch<{
        items: { id: string; externalId: string }[]
      }>(`/api/admin/documents?search=${encodeURIComponent(ext)}&limit=500`)
      const match = body.items.find((i) => i.externalId === ext)
      if (!match) {
        setError(`No document with external id "${ext}".`)
        return
      }
      const counterpartId = match.id
      const translationDocId = linkMode === 'translation' ? docId : counterpartId
      const originalDocId = linkMode === 'translation' ? counterpartId : docId
      await adminFetch('/api/admin/relations', {
        method: 'POST',
        body: JSON.stringify({ translationDocId, originalDocId }),
      })
      setNotice('Linked.')
      setLinkExt('')
      await load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const isOriginalOfConfirmed = docId
    ? relations.some(
        (r) => r.status === 'confirmed' && r.relatedDocumentId === docId,
      )
    : false

  return (
    <Box>
      {docId && isOriginalOfConfirmed && (
        <Text style={{ color: '#8a5a15', marginBottom: 8 }}>{ORPHAN_NOTE}</Text>
      )}
      {relations.length === 0 ? (
        <Text style={{ color: '#555' }}>No translation-pair suggestions.</Text>
      ) : (
        relations.map((r) => (
          <Box
            key={r.id}
            style={{ border: '1px solid #eee', padding: 8, marginBottom: 8 }}
          >
            <div style={{ marginBottom: 4 }}>
              <StatusChip status={r.status} />
            </div>
            {/* original (related_document_id) on top; the original always wins */}
            <div>
              <span>[{r.original.language ?? '?'}]</span>{' '}
              <span>{r.original.title ?? r.original.externalId}</span>{' '}
              <span>({r.original.externalId})</span> ← original
            </div>
            {r.status === 'suggested' && (
              <button
                type='button'
                aria-label='Flip direction'
                className='admin-btn'
                style={{ ...actionButton, margin: '4px 0' }}
                disabled={busyId === r.id}
                onClick={() => act(r.id, 'flip')}
              >
                ⇅
              </button>
            )}
            <div>
              <span>[{r.translation.language ?? '?'}]</span>{' '}
              <span>{r.translation.title ?? r.translation.externalId}</span>{' '}
              <span>({r.translation.externalId})</span> ← translation
            </div>
            {r.signals && Object.keys(r.signals).length > 0 && (
              <div style={{ color: '#595959', fontSize: 13 }}>
                signals: <SignalChips signals={r.signals} />
              </div>
            )}
            <div style={{ marginTop: 4 }}>
              {r.status === 'suggested' ? (
                <>
                  <button
                    type='button'
                    className='admin-btn'
                    style={actionButton}
                    disabled={busyId === r.id}
                    onClick={() => act(r.id, 'confirm')}
                  >
                    Confirm pair
                  </button>{' '}
                  <button
                    type='button'
                    className='admin-btn'
                    style={actionButton}
                    disabled={busyId === r.id}
                    onClick={() => act(r.id, 'reject')}
                  >
                    Not a pair
                  </button>
                </>
              ) : r.status === 'confirmed' ? (
                <button
                  type='button'
                  className='admin-btn'
                  style={actionButton}
                  disabled={busyId === r.id}
                  onClick={() => act(r.id, 'unlink')}
                >
                  Unlink
                </button>
              ) : null}
              {' '}
              <span style={{ color: '#595959', fontSize: 13 }}>
                suggested by {r.source}
                {r.confidence != null ? ` · confidence ${r.confidence}` : ''}
              </span>
            </div>
          </Box>
        ))
      )}
      {docId && (
        <Box style={{ marginTop: 12 }}>
          <Heading size='xs' style={{ marginBottom: 4 }}>
            Link a translation pair manually
          </Heading>
          <input
            type='text'
            aria-label='counterpart external id'
            placeholder='counterpart external id'
            value={linkExt}
            onChange={(e) => setLinkExt(e.target.value)}
            style={{ padding: '4px 8px', marginRight: 8 }}
          />
          <label style={{ marginRight: 8 }}>
            <input
              type='radio'
              name='linkmode'
              checked={linkMode === 'translation'}
              onChange={() => setLinkMode('translation')}
            />{' '}
            Link as translation of this document
          </label>
          <label style={{ marginRight: 8 }}>
            <input
              type='radio'
              name='linkmode'
              checked={linkMode === 'original'}
              onChange={() => setLinkMode('original')}
            />{' '}
            Link as original of this document
          </label>
          <button
            type='button'
            className='admin-btn'
            style={actionButton}
            onClick={submitLink}
          >
            Link
          </button>
        </Box>
      )}
      <Flash
        notice={notice}
        error={error}
        onDismiss={() => {
          setNotice(null)
          setError(null)
        }}
      />
    </Box>
  )
}

export default RelationsPanel
