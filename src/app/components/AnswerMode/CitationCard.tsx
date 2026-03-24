'use client'

import { useState } from 'react'
import { Box, Text, Heading, Spinner } from '@chakra-ui/react'
import { getThemedColor, Button, Tag } from '@worldresources/wri-design-systems'
import { FaQuoteRight } from 'react-icons/fa6'
import { IoIosCopy, IoMdOpen } from 'react-icons/io'
import { AiIcon } from '../icons/AiIcon'
import { chicagoFull, firstSentence } from '../../utils/utils'
import { CitationCardProps } from './types'

export const CitationCard = ({
  doc,
  kp,
  idx,
  itemRef,
  passageWhy,
  passageWhyLoading,
  docSummary,
  docSummaryLoading,
}: CitationCardProps) => {
  const [expandedSnippet, setExpandedSnippet] = useState(false)
  const [expandedWhy, setExpandedWhy] = useState(false)

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
      borderWidth='1px'
      borderColor={getThemedColor('neutral', 200)}
      backgroundColor='white'
    >
      {/* Why it answers */}
      <Box backgroundColor={getThemedColor('neutral', 200)} padding='3'>
        <Text
          fontSize='md'
          as='div'
          onClick={() => setExpandedWhy((prev) => !prev)}
          style={{ cursor: 'pointer' }}
        >
          <AiIcon /> How is this relevant?{' '}
        </Text>
        {expandedWhy &&
          (passageWhyLoading[passageId] ? (
            <Spinner size='xs' marginLeft='2' />
          ) : (
            <Text
              as='span'
              fontSize='sm'
              color={getThemedColor('neutral', 700)}
            >
              {whyData?.why || '—'}
            </Text>
          ))}
      </Box>

      {/* Actions */}
      <div style={{ display: 'flex', gap: '8px', padding: '8px 12px' }}>
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
          leftIcon={<IoIosCopy />}
          onClick={() => {
            navigator.clipboard.writeText(
              `${kp.snippet.trim()}\n\n${chicagoFull(doc)}`,
            )
          }}
        >
          Copy passage
        </Button>
      </div>
      {/* Snippet preview */}
      <Box
        margin='3'
        paddingX='3'
        borderLeftWidth='5px'
        borderColor={getThemedColor('neutral', 200)}
        position='relative'
        minHeight={150}
      >
        <Text
          fontSize='sm'
          style={
            expandedSnippet
              ? {}
              : {
                  display: '-webkit-box',
                  WebkitLineClamp: 6,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  position: 'relative',
                }
          }
        >
          &rdquo;{kp.snippet}&rdquo;
        </Text>
        {!expandedSnippet && kp.snippet.length > 120 && (
          <Box
            position='absolute'
            left={0}
            right={0}
            bottom={0}
            height={100}
            background='linear-gradient(to bottom, rgba(255,255,255,0) 0%, white 90%)'
            display='flex'
            alignItems='flex-end'
            justifyContent='center'
            pointerEvents='none'
            zIndex={1}
          >
            {/* Fade overlay */}
          </Box>
        )}
        {!expandedSnippet && kp.snippet.length > 120 && (
          <Box
            position='absolute'
            left={0}
            right={0}
            bottom={0}
            display='flex'
            alignItems='flex-end'
            justifyContent='center'
            zIndex={2}
            pointerEvents='auto'
            minHeight={200}
            height={200}
          >
            <Button
              size='small'
              variant='borderless'
              style={{ margin: '8px 0' }}
              onClick={() => setExpandedSnippet(true)}
            >
              Show more
            </Button>
          </Box>
        )}
        {expandedSnippet && kp.snippet.length > 120 && (
          <Box
            position='relative'
            left={0}
            right={0}
            bottom={0}
            display='flex'
            alignItems='flex-end'
            justifyContent='center'
            zIndex={2}
            pointerEvents='auto'
          >
            <Button
              size='small'
              variant='borderless'
              style={{ margin: '8px 0' }}
              onClick={() => setExpandedSnippet(false)}
            >
              Show less
            </Button>
          </Box>
        )}
      </Box>

      <div style={{ width: '100px', margin: '0 12px' }}>
        <Tag
          icon={<FaQuoteRight />}
          label={`Page ${kp.page}`}
          variant='info-white'
        />
      </div>

      {/* Title */}
      <Heading
        padding='3'
        size='sm'
        color={getThemedColor('neutral', 900)}
        style={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {docTitle}
      </Heading>

      {/* Doc summary */}
      <Box marginTop='1' paddingX='3' paddingBottom='2'>
        <Text
          fontSize='xs'
          color={getThemedColor('neutral', 700)}
          fontWeight='medium'
          marginBottom='1'
        >
          Doc summary
        </Text>
        <Text fontSize='sm' color={getThemedColor('neutral', 700)}>
          {docSummaryLoading[doc.doc_id] ? (
            <Spinner size='xs' />
          ) : (
            summary || firstSentence(kp.snippet) || '—'
          )}
        </Text>
      </Box>

      {/* Citation info */}
      <Text
        padding='3'
        fontSize='xs'
        color={getThemedColor('neutral', 600)}
        marginBottom='3'
      >
        {authors}
        {year && ` (${year})`} • p.{kp.page || '?'}
      </Text>
    </Box>
  )
}
