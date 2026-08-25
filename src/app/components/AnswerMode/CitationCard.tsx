'use client'

import { useState } from 'react'
import { Box, Text, Spinner } from '@chakra-ui/react'
import { getThemedColor, Button, Tag } from '@worldresources/wri-design-systems'
import { IoIosCopy, IoMdCheckmark, IoMdOpen } from 'react-icons/io'
import { VscTriangleRight } from 'react-icons/vsc'
import { AiIcon } from '../icons/AiIcon'
import {
  authorsFrom,
  chicagoFull,
  matchCatalogRow,
  publisherFrom,
  titleFrom,
  yearFrom,
} from '../../utils/utils'
import { CitationCardProps } from './types'

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
          {expandedSnippet && isTranslatable && (
            <Button
              variant='borderless'
              size='small'
              onClick={onTranslate}
              disabled={translating}
            >
              {translating
                ? 'Translating…'
                : showTranslation
                  ? 'Show original'
                  : 'Translate'}
            </Button>
          )}
        </Box>

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
        {expandedSnippet && showTranslation && translation && (
          <Text fontSize='xs' color={getThemedColor('neutral', 700)}>
            Translated to English by AI <AiIcon />
          </Text>
        )}
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
        <Button variant='secondary' size='small' leftIcon={<IoMdOpen />}>
          <a
            href={`api/pdf/${doc.doc_id}.pdf#page=${kp.page || 1}`}
            target='_blank'
            rel='noopener noreferrer'
          >
            Open document
          </a>
        </Button>
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
          {copied ? 'Copied' : 'Copy passage'}
        </Button>
      </div>
    </Box>
  )
}
