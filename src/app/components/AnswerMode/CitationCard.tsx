'use client'

import { useState } from 'react'
import { Box, Text, Spinner } from '@chakra-ui/react'
import { getThemedColor, Button } from '@worldresources/wri-design-systems'
import { IoIosCopy, IoMdCheckmark, IoMdOpen } from 'react-icons/io'
import { VscTriangleRight } from 'react-icons/vsc'
import { AiIcon } from '../icons/AiIcon'
import { chicagoFull } from '../../utils/utils'
import { CitationCardProps } from './types'

export const CitationCard = ({
  doc,
  kp,
  idx,
  isActive,
  isDirectlyCited,
  citationLabel,
  itemRef,
  passageWhy,
  passageWhyLoading,
  docSummary,
  docSummaryLoading,
}: CitationCardProps) => {
  const [expandedSnippet, setExpandedSnippet] = useState(false)
  const [expandedWhy, setExpandedWhy] = useState(false)
  const [expandedSummary, setExpandedSummary] = useState(false)
  const [copied, setCopied] = useState(false)

  const passageId = `${doc.doc_id}:${kp.passage_id}`
  const whyData = passageWhy[passageId]
  const summary = docSummary[doc.doc_id]
  const docTitle = doc.title || `Document ${doc.doc_id?.slice(0, 8) || idx + 1}`
  const authors = doc.authors?.join('; ') || 'Unknown author'
  const year = doc.year || ''

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
      <Box display='flex'>
        <Text fontSize='xs' color='#0A4298'>
          {citationLabel && ` Citation ${citationLabel} \u2022 `}
          {`${kp.kp_relevance.toFixed(2)} relevance`}
        </Text>
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
          {`Excerpt (Page ${kp.page})`}
        </Text>

        <Text
          fontSize='sm'
          style={{
            borderLeft: `4px solid ${getThemedColor('neutral', 300)}`,
            paddingLeft: '8px',
          }}
        >
          {expandedSnippet && <>&rdquo;{kp.snippet}&rdquo;</>}
        </Text>
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
            <Text fontSize='sm'>
              {docSummaryLoading[doc.doc_id] ? <Spinner size='xs' /> : summary}
            </Text>

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
              {`Washington, DC: WRI ${year ? `(${year})` : ''}`}
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
            navigator.clipboard.writeText(
              `${kp.snippet.trim()}\n\n${chicagoFull(doc)}`,
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
