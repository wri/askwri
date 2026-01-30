'use client'

import { ActionBar, Heading, Portal, Text } from '@chakra-ui/react'
import { Button, getThemedColor } from '@worldresources/wri-design-systems'
import { FaChevronUp } from 'react-icons/fa'
import { ExportActionBarProps } from './types'

export function ExportActionBar({
  selectedCount,
  onSelectAll,
  onExport,
  bottomOffset = '80px',
}: ExportActionBarProps) {
  if (!selectedCount) {
    return null
  }

  return (
    <ActionBar.Root open>
      <Portal>
        <ActionBar.Positioner bottom={bottomOffset}>
          <ActionBar.Content
            style={{
              width: 800,
              backgroundColor: getThemedColor('neutral', 800),
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <ActionBar.SelectionTrigger
              style={{
                border: 'none',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '4px',
              }}
            >
              <Heading size='md' color={getThemedColor('neutral', 100)}>
                Export citations
              </Heading>

              <Text color={getThemedColor('neutral', 100)}>
                {selectedCount} selected
              </Text>
            </ActionBar.SelectionTrigger>
            <div style={{ display: 'flex', gap: '12px' }}>
              <Button variant='secondary' onClick={onSelectAll}>
                Select all
              </Button>
              <Button
                variant='primary'
                rightIcon={<FaChevronUp />}
                onClick={onExport}
              >
                Export citations
              </Button>
            </div>
          </ActionBar.Content>
        </ActionBar.Positioner>
      </Portal>
    </ActionBar.Root>
  )
}
