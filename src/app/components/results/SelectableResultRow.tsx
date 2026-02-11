'use client'

import { useState } from 'react'
import { Heading } from '@chakra-ui/react'
import {
  TableRow,
  TableCell,
  Tag,
  Checkbox,
  Button,
  getThemedColor,
} from '@worldresources/wri-design-systems'
import { FaThumbsDown, FaThumbsUp } from 'react-icons/fa6'
import { PiDownloadSimpleBold } from 'react-icons/pi'
import { SelectableResultRowProps } from './types'

export const SelectableResultRow = ({
  rowData,
  selected,
  isActive = false,
  onCheckedChange,
  docSummaryLoading,
  docWhyLoading,
  onTitleClick,
}: SelectableResultRowProps) => {
  const [isHovered, setIsHovered] = useState(false)

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
      <TableCell width={450}>
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
      <TableCell width={400}>
        {docSummaryLoading?.[rowData.id.toString()] ? (
          <span>Loading...</span>
        ) : (
          <div
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {rowData.summary}
          </div>
        )}
      </TableCell>
      <TableCell width={140}>
        <div style={{ width: 'fit-content' }}>
          <Tag label={rowData.relevance} variant='success' />
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
            leftIcon={<PiDownloadSimpleBold />}
            aria-label='Download publication'
            onClick={handleDownload}
            disabled={!rowData.download_url}
          />
          <Button
            variant='borderless'
            leftIcon={<FaThumbsUp />}
            aria-label='Mark as helpful'
          />
          <Button
            variant='borderless'
            leftIcon={<FaThumbsDown />}
            aria-label='Mark as not helpful'
          />
        </div>
      </TableCell>
    </TableRow>
  )
}
