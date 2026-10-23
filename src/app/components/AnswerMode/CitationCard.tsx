'use client'

import { useState, useEffect } from 'react'
import { Box, Text, Spinner } from '@chakra-ui/react'
import {
  getThemedColor,
  getThemedFontSize,
  Button,
  Tag,
  Menu,
} from '@worldresources/wri-design-systems'
import { IoIosCopy, IoMdCheckmark, IoMdOpen } from 'react-icons/io'
import { MdTranslate } from 'react-icons/md'
import { CgSpinner } from 'react-icons/cg'
import { VscTriangleRight } from 'react-icons/vsc'
import { FaChevronDown } from 'react-icons/fa'
import { AiIcon } from '../icons/AiIcon'
import {
  authorsFrom,
  chicagoFull,
  languageNameFromCode,
  matchCatalogRow,
  publisherFrom,
  titleFrom,
  yearFrom,
} from '../../utils/utils'
import { CitationCardProps } from './types'
import { DocumentVersion } from '@/app/utils/documentVersions'

// One request per document, shared across every citation card for the same doc.
const versionsCache = new Map<string, Promise<DocumentVersion[]>>()

const fetchDocumentVersions = (docId: string) => {
  if (!versionsCache.has(docId)) {
    versionsCache.set(
      docId,
      fetch(`/api/documents/${docId}/versions`)
        .then((res) => res.json())
        .then((j) => (j.ok && j.versions ? j.versions : []))
        .catch((error) => {
          console.error('Failed to fetch document versions:', error)
          return []
        }),
    )
  }
  return versionsCache.get(docId)!
}

export const CitationCard = ({
  doc,
  kp,
  idx,
  catalogIndex,
  isActive,
  isDirectlyCited,
  citationLabel,
  sourceRelevance,
  itemRef,
  passageWhy,
  passageWhyLoading,
}: CitationCardProps) => {
  const [expandedSnippet, setExpandedSnippet] = useState(false)
  const [expandedWhy, setExpandedWhy] = useState(false)
  const [expandedSummary, setExpandedSummary] = useState(false)
  const [copied, setCopied] = useState(false)
  const [translation, setTranslation] = useState<string | null>(null)
  const [showTranslation, setShowTranslation] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [translateError, setTranslateError] = useState(false)
  const [documentVersions, setDocumentVersions] = useState<DocumentVersion[]>(
    [],
  )

  const passageId = `${doc.doc_id}:${kp.passage_id}`
  const whyData = passageWhy[passageId]

  const tier = sourceRelevance?.[doc.doc_id]
  const row = catalogIndex ? matchCatalogRow(doc, catalogIndex) : undefined
  // All four come from the document-management columns via the catalog, not
  // from the chunk metadata the retriever returns (issue #305).
  const docTitle =
    titleFrom(doc, row) || `Document ${doc.doc_id?.slice(0, 8) || idx + 1}`
  const authors = authorsFrom(doc, row).join('; ') || 'Unknown author'
  const year = yearFrom(doc, row) ?? ''
  const publisher = publisherFrom(row)
  // Short English summary — the long one is a wall of text in a side panel.
  const summary = row?.shortSummary || row?.summary
  const isTranslatable = Boolean(row?.language && row.language !== 'en')

  useEffect(() => {
    if (!doc.doc_id) return
    let active = true
    fetchDocumentVersions(doc.doc_id).then((versions) => {
      if (active) setDocumentVersions(versions)
    })
    return () => {
      active = false
    }
  }, [doc.doc_id])

  const onTranslate = async () => {
    if (translation) {
      setShowTranslation((prev) => !prev)
      return
    }
    setTranslating(true)
    setTranslateError(false)
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: kp.snippet }),
      })
      const j = await res.json()
      if (j?.ok && j.translation) {
        setTranslation(j.translation)
        setShowTranslation(true)
      } else {
        setTranslateError(true)
      }
    } catch {
      setTranslateError(true)
    } finally {
      setTranslating(false)
    }
  }

  return (
    <Box
      key={`${doc.doc_id}-${kp.passage_id}`}
      ref={itemRef}
      borderWidth={isDirectlyCited ? '2px' : '1px'}
      borderColor={
        isDirectlyCited && isActive ? '#0A4298' : getThemedColor('neutral', 300)
      }
      borderRadius='8px'
      background='white'
      padding='16px'
    >
      <Box display='flex' alignItems='center' gap='2'>
        {citationLabel && (
          <Text fontSize='xs' color='#0A4298'>
            {`Citation ${citationLabel}`}
          </Text>
        )}
        {tier && (
          <Tag
            label={`${tier.charAt(0).toUpperCase()}${tier.slice(1)}`}
            variant={
              tier === 'strong'
                ? 'success'
                : tier === 'partial'
                  ? 'warning'
                  : 'info-grey'
            }
          />
        )}
      </Box>

      {/* Title */}
      <Text
        fontSize='md'
        style={{
          margin: '8px 0px',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {docTitle}
      </Text>

      {row?.language && row.language !== 'en' && (
        <Text
          style={{
            color: getThemedColor('neutral', 700),
            fontSize: getThemedFontSize(300),
          }}
        >
          Document reviewed in {languageNameFromCode(row.language)}.
        </Text>
      )}

      {/* Excerpt */}
      <Box>
        <Box display='flex' alignItems='center' gap='2'>
          <Text
            onClick={() => setExpandedSnippet((prev) => !prev)}
            as='div'
            style={{
              padding: '4px 0px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <VscTriangleRight
              style={{
                color: getThemedColor('neutral', 700),
                transition: 'transform 0.2s',
                transform: expandedSnippet ? 'rotate(90deg)' : 'rotate(0deg)',
                flexShrink: 0,
              }}
            />
            {`Excerpt (Page ${kp.page ?? 1})`}
          </Text>
        </Box>

        {expandedSnippet && isTranslatable && (
          <Button
            variant='borderless'
            size='small'
            leftIcon={translating ? <CgSpinner /> : <MdTranslate />}
            onClick={onTranslate}
            disabled={translating}
          >
            {translating
              ? 'Translating…'
              : showTranslation
                ? 'Show original'
                : 'Translate to English (AI)'}
          </Button>
        )}

        <Text
          fontSize='sm'
          style={{
            borderLeft: `4px solid ${getThemedColor('neutral', 300)}`,
            paddingLeft: '8px',
          }}
        >
          {expandedSnippet && (
            <>
              &rdquo;
              {showTranslation && translation ? translation : kp.snippet}
              &rdquo;
            </>
          )}
        </Text>

        {expandedSnippet && translateError && (
          <Text fontSize='xs' color={getThemedColor('error', 700)}>
            Translation unavailable — showing the original.
          </Text>
        )}
      </Box>

      {/* How is this relevant? */}
      <Box>
        <Text
          onClick={() => setExpandedWhy((prev) => !prev)}
          as='div'
          style={{
            padding: '8px 0px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <VscTriangleRight
            style={{
              color: getThemedColor('neutral', 700),
              transition: 'transform 0.2s',
              transform: expandedWhy ? 'rotate(90deg)' : 'rotate(0deg)',
              flexShrink: 0,
            }}
          />
          How is this relevant? <AiIcon />
        </Text>
        {expandedWhy &&
          (passageWhyLoading[passageId] ? (
            <Spinner size='xs' marginLeft='2' />
          ) : (
            <Text as='span' fontSize='sm'>
              {whyData?.why || '—'}
            </Text>
          ))}
      </Box>

      {/* Doc summary */}
      <Box paddingBottom='2'>
        <Text
          onClick={() => setExpandedSummary((prev) => !prev)}
          as='div'
          style={{
            padding: '8px 0px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <VscTriangleRight
            style={{
              color: getThemedColor('neutral', 700),
              transition: 'transform 0.2s',
              transform: expandedSummary ? 'rotate(90deg)' : 'rotate(0deg)',
              flexShrink: 0,
            }}
          />
          Document Summary
        </Text>
        {expandedSummary && (
          <>
            <Text fontSize='sm'>{summary || 'No summary available.'}</Text>

            {/* Citation info */}
            <Text
              fontSize='sm'
              padding='8px 0px'
              color={getThemedColor('neutral', 700)}
            >
              {authors}
            </Text>

            <Text
              fontSize='sm'
              color={getThemedColor('neutral', 700)}
              paddingBottom='8px'
              fontStyle='italic'
            >
              {`${publisher} ${year ? `(${year})` : ''}`.trim()}
            </Text>
          </>
        )}
      </Box>

      {/* Actions */}
      <div style={{ display: 'flex', gap: '8px', padding: '8px 0px' }}>
        {documentVersions.length > 1 ? (
          <Menu
            label='Open document'
            items={documentVersions.map((version) => ({
              label: `${languageNameFromCode(version.language)}${version.isOriginal ? ' (original)' : ''}`,
              value: version.url || '',
            }))}
            onSelect={(value) => {
              if (value) {
                window.open(value, '_blank', 'noopener,noreferrer')
              }
            }}
            customTrigger={
              <Button
                variant='secondary'
                size='small'
                leftIcon={<IoMdOpen />}
                rightIcon={<FaChevronDown />}
                label={
                  // font size fix as it was overridden by the Menu component
                  <div style={{ fontSize: getThemedFontSize(200) }}>
                    Open document
                  </div>
                }
              />
            }
          />
        ) : (
          <Button variant='secondary' size='small' rightIcon={<IoMdOpen />}>
            <a
              href={`api/pdf/${doc.doc_id}.pdf#page=${kp.page || 1}`}
              target='_blank'
              rel='noopener,noreferrer'
            >
              Open document
            </a>
          </Button>
        )}
        <Button
          variant='secondary'
          size='small'
          leftIcon={copied ? <IoMdCheckmark /> : <IoIosCopy />}
          onClick={() => {
            const passage = (
              showTranslation && translation ? translation : kp.snippet
            ).trim()
            navigator.clipboard.writeText(
              `${passage}\n\n${chicagoFull(doc, row)}`,
            )
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? 'Copied' : 'Copy excerpt & citation'}
        </Button>
      </div>
    </Box>
  )
}
