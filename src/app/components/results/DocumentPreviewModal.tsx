'use client'

import { Text, Heading } from '@chakra-ui/react'
import { Button, getThemedColor, Tag } from '@worldresources/wri-design-systems'
import { AiIcon } from '../icons/AiIcon'
import { DocumentPreviewModalContentProps } from './types'

export const DocumentPreviewModalContent = ({
  rowData,
  onExportBib,
}: DocumentPreviewModalContentProps) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
    <div style={{ width: 'fit-content' }}>
      <Tag
        label={`${rowData.relevance} Relevance`}
        variant={
          rowData.relevance === 'Strong'
            ? 'success'
            : rowData.relevance === 'Partial'
              ? 'warning'
              : rowData.relevance === 'Weak'
                ? 'info-grey'
                : 'success'
        }
      />
    </div>
    <div>
      <Heading size='2xl'>{rowData.publication_title}</Heading>
    </div>

    <div>
      <Text
        textStyle='md'
        style={{
          marginBottom: '8px',
        }}
      >
        {rowData.short_summary || rowData.summary}
      </Text>
      <Text
        style={{
          color: getThemedColor('neutral', 700),
        }}
      >
        {rowData.author}
      </Text>
      <Text
        style={{
          color: getThemedColor('neutral', 700),
        }}
      >
        {rowData.year}
      </Text>
    </div>
    <div
      style={{
        border: `1px solid ${getThemedColor('neutral', 300)}`,
        padding: '16px',
        borderRadius: '4px',
      }}
    >
      <Text
        textStyle='md'
        style={{
          marginBottom: '8px',
          color: getThemedColor('neutral', 800),
        }}
      >
        <AiIcon /> How is this relevant?
      </Text>
      <Text
        style={{
          color: getThemedColor('neutral', 700),
        }}
      >
        {rowData.how_relevant}
      </Text>
    </div>

    <div
      style={{
        border: `1px solid ${getThemedColor('neutral', 300)}`,
        borderRadius: '4px',
      }}
    >
      <div
        style={{
          padding: '8px',
          background: getThemedColor('neutral', 200),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        PDF preview
        <Button
          variant='secondary'
          size='small'
          onClick={() => {
            if (rowData.download_url) {
              window.open(rowData.download_url, '_blank', 'noopener,noreferrer')
            }
          }}
        >
          Open Document
        </Button>
      </div>
      <div
        style={{
          width: '100%',
          height: '500px',
          padding: '12px',
          overflow: 'hidden',
        }}
      >
        {rowData.download_url ? (
          <iframe
            src={`${rowData.download_url}#page=1&view=FitH`}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
            }}
            title='PDF Preview'
          />
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: getThemedColor('neutral', 600),
            }}
          >
            No PDF available
          </div>
        )}
      </div>
    </div>

    <div>
      <Button
        variant='secondary'
        onClick={() => {
          onExportBib?.([rowData.id.toString()])
        }}
      >
        Export citations (.csv)
      </Button>
    </div>
  </div>
)
