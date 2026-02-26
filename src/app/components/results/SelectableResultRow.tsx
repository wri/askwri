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
import { FaThumbsDown, FaThumbsUp } from 'react-icons/fa6'
import { PiDownloadSimpleBold } from 'react-icons/pi'
import { SelectableResultRowProps } from './types'

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
  // 0 = no vote, 1 = positive, -1 = negative
  const [vote, setVote] = useState<0 | 1 | -1>(0)
  // logSent: null = not sent, 'loading' = sending, 'success' = sent
  const [logSent, setLogSent] = useState<null | 'loading' | 'success'>(null)

  const sendLog = async (feedbackType: 'positive' | 'negative') => {
    setLogSent('loading')
    try {
      const feedbackData = {
        docId: rowData.id,
        feedback: feedbackType,
        howRelevant: rowData.how_relevant,
        mode: 'cite',
        publicationName: rowData.publication_name,
        query,
        relevanceScore: rowData.relevance,
        rowNumber: rowNumber,
        summary: rowData.summary,
      }
      const res = await fetch('/api/cite-mode-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feedbackData),
      })
      if (res.ok) {
        setLogSent('success')
      } else {
        setLogSent(null)
      }
    } catch {
      setLogSent(null)
    }
  }

  const handleOnRowSelected = ({ checked }: { checked: boolean | string }) => {
    onCheckedChange(rowData, checked)
  }

  const handleDownload = () => {
    if (!rowData.download_url) return

    window.open(rowData.download_url, '_blank', 'noopener,noreferrer')
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
          {rowData.publication_name}
        </Heading>
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
      <TableCell width='20%'>
        {docSummaryLoading?.[rowData.id.toString()] ? (
          <span>Loading...</span>
        ) : (
          <div>
            {rowData.summary && rowData.summary.length > SUMMARY_MAX_LENGTH
              ? `${rowData.summary.slice(0, SUMMARY_MAX_LENGTH)}...`
              : rowData.summary}
          </div>
        )}
      </TableCell>
      <TableCell width={120}>
        <div style={{ width: 'fit-content' }}>
          <Tooltip content='0 to 1, where 1 is most relevant'>
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
          <Button
            variant='borderless'
            leftIcon={
              <Tooltip content='Copy citation to clipboard'>
                <PiDownloadSimpleBold />
              </Tooltip>
            }
            aria-label='Download publication'
            onClick={handleDownload}
            disabled={!rowData.download_url}
          />
          <Button
            variant='borderless'
            leftIcon={
              logSent === 'loading' && vote === 1 ? (
                <Spinner />
              ) : (
                <Tooltip content='Mark as good result'>
                  <FaThumbsUp />
                </Tooltip>
              )
            }
            aria-label='Mark as good result'
            onClick={() => {
              if (vote === 1) {
                setVote(0)
                setLogSent(null)
              } else {
                setVote(1)
                sendLog('positive')
              }
            }}
            style={
              vote === 1
                ? {
                    background: getThemedColor('success', 300),
                    color: getThemedColor('success', 900),
                    opacity: 0.8,
                  }
                : {}
            }
            disabled={vote === 1 && logSent === 'loading'}
          />
          <Button
            variant='borderless'
            leftIcon={
              logSent === 'loading' && vote === -1 ? (
                <Spinner />
              ) : (
                <Tooltip content='Mark as poor result'>
                  <FaThumbsDown />
                </Tooltip>
              )
            }
            aria-label='Mark as poor result'
            onClick={() => {
              if (vote === -1) {
                setVote(0)
                setLogSent(null)
              } else {
                setVote(-1)
                sendLog('negative')
              }
            }}
            style={
              vote === -1
                ? {
                    background: getThemedColor('error', 300),
                    color: getThemedColor('error', 900),
                    opacity: 0.8,
                  }
                : {}
            }
            disabled={vote === -1 && logSent === 'loading'}
          />
        </div>
      </TableCell>
    </TableRow>
  )
}
