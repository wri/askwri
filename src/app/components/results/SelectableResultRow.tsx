'use client'

import { useState, FC } from 'react'
import { Heading, Spinner } from '@chakra-ui/react'
import {
  TableRow,
  TableCell,
  Tag,
  Checkbox,
  Button,
  getThemedColor,
  Tooltip as DS_Tooltip,
} from '@worldresources/wri-design-systems'
import { IoIosCopy } from 'react-icons/io'
import { FaThumbsDown, FaThumbsUp } from 'react-icons/fa6'
import { chicagoFull } from '../../utils/utils'
import {
  SelectableResultRowProps,
  FeedbackType,
  FeedbackSubmitted,
} from './types'

const Tooltip = DS_Tooltip as FC<any> // temporary fix to resolve type issues with Tooltip component from wri-design-systems

const SUMMARY_MAX_LENGTH = 240

export const SelectableResultRow = ({
  query,
  rowData,
  rowNumber,
  selected,
  isActive = false,
  onCheckedChange,
  docSummaryLoading,
  docWhyLoading,
  onTitleClick,
}: SelectableResultRowProps) => {
  const [isHovered, setIsHovered] = useState(false)

  // 0 = no feedbackState, 1 = positive, -1 = negative
  const [feedbackState, setFeedbackState] = useState<FeedbackType>(
    FeedbackType.None,
  )
  // feedbackSubmitted: null = not sent, 'loading' = sending, 'success' = sent
  const [feedbackSubmitted, setFeedbackSubmitted] = useState<FeedbackSubmitted>(
    FeedbackSubmitted.Unsent,
  )

  const submitFeedback = async (feedbackType: FeedbackType) => {
    setFeedbackSubmitted(FeedbackSubmitted.Loading)
    try {
      const feedbackData = {
        docId: rowData.id,
        feedback:
          feedbackType === FeedbackType.Positive ? 'positive' : 'negative',
        howRelevant: rowData.how_relevant,
        mode: 'cite',
        publicationName: rowData.publication_title,
        query,
        relevanceScore: rowData.relevance,
        rowNumber,
        summary: rowData.short_summary,
      }
      const res = await fetch('/api/cite-mode-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feedbackData),
      })
      if (res.ok) {
        setFeedbackSubmitted(FeedbackSubmitted.Success)
      } else {
        setFeedbackSubmitted(FeedbackSubmitted.Unsent)
      }
    } catch {
      setFeedbackSubmitted(FeedbackSubmitted.Unsent)
    }
  }

  const handleFeedback = (type: FeedbackType) => {
    if (feedbackState === type) {
      setFeedbackState(FeedbackType.None)
      setFeedbackSubmitted(FeedbackSubmitted.Unsent)
    } else {
      setFeedbackState(type)
      submitFeedback(type)
    }
  }

  const handleOnRowSelected = ({ checked }: { checked: boolean | string }) => {
    onCheckedChange(rowData, checked)
  }

  return (
    <TableRow
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        backgroundColor: isActive ? getThemedColor('primary', 200) : undefined,
      }}
    >
      <TableCell>
        <Checkbox
          name={`checkbox-${rowData.id}`}
          onCheckedChange={handleOnRowSelected}
          checked={selected}
        />
      </TableCell>
      <TableCell width='28%'>
        <Heading
          size='lg'
          onClick={() => onTitleClick?.(rowData)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && onTitleClick) {
              e.preventDefault()
              onTitleClick(rowData)
            }
          }}
          tabIndex={onTitleClick ? 0 : undefined}
          role={onTitleClick ? 'button' : undefined}
          style={{
            cursor: onTitleClick ? 'pointer' : 'default',
            textDecoration: onTitleClick && isHovered ? 'underline' : 'none',
          }}
        >
          {rowData.publication_title}
        </Heading>
        <div>{rowData.year}</div>
        <div
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {rowData.author}
        </div>
      </TableCell>
      <TableCell width='25%'>
        {docSummaryLoading?.[rowData.id.toString()] ? (
          <span>Loading...</span>
        ) : (
          <div>
            {rowData.short_summary &&
            rowData.short_summary.length > SUMMARY_MAX_LENGTH
              ? `${rowData.short_summary.slice(0, SUMMARY_MAX_LENGTH)}...`
              : rowData.short_summary}
          </div>
        )}
      </TableCell>
      <TableCell width={120}>
        <div style={{ width: 'fit-content' }}>
          <Tooltip content='How relevant this document is compared with other results for this query. The top result is scaled to 1.0'>
            <Tag label={rowData.relevance} variant='success' />
          </Tooltip>
        </div>
      </TableCell>
      <TableCell>
        {docWhyLoading?.[rowData.id.toString()] ? (
          <span>Loading...</span>
        ) : (
          rowData.how_relevant
        )}
      </TableCell>
      <TableCell>
        <div
          onFocus={() => setIsHovered(true)}
          onBlur={() => setIsHovered(false)}
          style={{
            display: 'flex',
            gap: '8px',
            opacity: isHovered ? 1 : 0.1,
            transition: 'opacity 0.2s ease-in-out',
          }}
        >
          <Tooltip content='Copy citation to clipboard'>
            <Button
              as='div'
              variant='borderless'
              leftIcon={<IoIosCopy />}
              aria-label='Copy citation to clipboard'
              onClick={() => {
                const { fullDoc } = rowData
                navigator.clipboard.writeText(chicagoFull(fullDoc, rowData))
              }}
            />
          </Tooltip>
          <Tooltip content='Mark as good result'>
            <Button
              as='div'
              variant='borderless'
              leftIcon={
                feedbackSubmitted === FeedbackSubmitted.Loading &&
                feedbackState === FeedbackType.Positive ? (
                  <Spinner />
                ) : (
                  <FaThumbsUp />
                )
              }
              aria-label='Mark as good result'
              onClick={() => handleFeedback(FeedbackType.Positive)}
              style={
                feedbackState === FeedbackType.Positive
                  ? {
                      background: getThemedColor('success', 300),
                      color: getThemedColor('success', 900),
                      opacity: 0.8,
                    }
                  : {}
              }
              disabled={
                feedbackState === FeedbackType.Positive &&
                feedbackSubmitted === FeedbackSubmitted.Loading
              }
            />
          </Tooltip>
          <Tooltip content='Mark as poor result'>
            <Button
              as='div'
              variant='borderless'
              leftIcon={
                feedbackSubmitted === FeedbackSubmitted.Loading &&
                feedbackState === FeedbackType.Negative ? (
                  <Spinner />
                ) : (
                  <FaThumbsDown />
                )
              }
              aria-label='Mark as poor result'
              onClick={() => handleFeedback(FeedbackType.Negative)}
              style={
                feedbackState === FeedbackType.Negative
                  ? {
                      background: getThemedColor('error', 300),
                      color: getThemedColor('error', 900),
                      opacity: 0.8,
                    }
                  : {}
              }
              disabled={
                feedbackState === FeedbackType.Negative &&
                feedbackSubmitted === FeedbackSubmitted.Loading
              }
            />
          </Tooltip>
        </div>
      </TableCell>
    </TableRow>
  )
}
