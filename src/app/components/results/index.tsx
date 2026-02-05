'use client'

import { Heading, Box, List, Text } from '@chakra-ui/react'
import { Button, Tag, getThemedColor } from '@worldresources/wri-design-systems'
import { FaInfoCircle, FaSearch } from 'react-icons/fa'
import { HiCurrencyDollar } from 'react-icons/hi2'
import { AiFillThunderbolt } from 'react-icons/ai'
import { TfiThought } from 'react-icons/tfi'
import { AiIcon } from '../icons/AiIcon'
import Navbar from './Navbar'
import ResultsTable from './ResultsTable'
import { ResultsPageProps } from './types'
import '../../styles.css'

const ResultsPage = ({
  data = [],
  query,
  confidence = 0,
  docSummaryLoading,
  docWhyLoading,
  onOpenPdf,
}: ResultsPageProps) => {
  const tableData = data.map((row) => ({
    ...row,
    publication_name: row.publication_name,
  }))

  return (
    <main className='gradient-background' style={{ paddingBottom: '57px' }}>
      <Navbar />
      <section
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px',
          background: getThemedColor('neutral', 100),
          border: `1px solid ${getThemedColor('neutral', 300)}`,
        }}
      >
        <div>
          <Text textStyle='sm'>
            Returned results for publications WRI has published on:
            <b>{` "${query}"`}</b>
          </Text>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <Button
            leftIcon={<AiFillThunderbolt />}
            variant='borderless'
            size='small'
            label='2.48 gCO2e'
            aria-label='Carbon equivalent of search'
            onClick={() => {}}
          />
          <Button
            leftIcon={<HiCurrencyDollar />}
            variant='borderless'
            size='small'
            label='$0.21'
            aria-label='Cost of credits used in search'
            onClick={() => {}}
          />
          <Button
            leftIcon={<FaSearch />}
            variant='secondary'
            size='small'
            label='Improve Search'
            aria-label='Improve Search'
            onClick={() => {}}
          />
          <Button
            leftIcon={<TfiThought />}
            variant='secondary'
            disabled={query.trim() === ''}
            size='small'
            label='Explain AI process'
            aria-label='Explain AI process'
            onClick={() => {}}
          />
        </div>
      </section>
      <section style={{ padding: '0 2rem', maxWidth: '800px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            margin: '20px 0px',
          }}
        >
          <AiIcon />
          <Heading size='2xl'>Overview</Heading>
        </div>

        <Box style={{ paddingBottom: '1rem' }}>
          <List.Root>
            <List.Item>
              Your search reviewed 500 publications and found 12 highly relevant
              and 23 moderately relevant results.
            </List.Item>
            <List.Item>
              Overall confidence is 40% because several sources discuss urban
              growth broadly rather than compact growth in India, with limited
              coverage from the last five years.
            </List.Item>
            <List.Item>
              You can improve your search by including a timeframe, for example
              “between 2019–2025”, and a more specific topic, for example
              interest in policies or outcomes related to compact urban growth
            </List.Item>
          </List.Root>
        </Box>
        <div
          style={{
            width: '150px',
            alignItems: 'center',
            marginBottom: '16px',
          }}
        >
          <Tag
            icon={<FaInfoCircle />}
            label={`${confidence}% Confidence`}
            variant='info-white'
          />
        </div>
      </section>
      <ResultsTable
        data={tableData}
        docSummaryLoading={docSummaryLoading}
        docWhyLoading={docWhyLoading}
        onOpenPdf={onOpenPdf}
      />
    </main>
  )
}

export default ResultsPage
