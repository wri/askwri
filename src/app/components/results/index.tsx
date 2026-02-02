'use client'

import { Heading, Box, List } from '@chakra-ui/react'
import { ProgressBar, Tag } from '@worldresources/wri-design-systems'
import { FaInfoCircle } from 'react-icons/fa'
import { AiIcon } from '../icons/AiIcon'
import Navbar from './Navbar'
import ResultsTable from './ResultsTable'
import { RowData } from './types'
import '../../styles.css'

type ResultsPageProps = {
  data?: RowData[]
  query: string
  confidence?: number
}


const ResultsPage = ({ data = [], query, confidence = 0 }: ResultsPageProps) => {
  const tableData = data.map((row) => ({
    ...row,
    publication_name: row.publication_name,
  }))
  console.log({tableData})
  console.log({confidence})
  return (
  <main className='gradient-background' style={{ paddingBottom: '57px' }}>
    <Navbar />
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
        <Heading size='2xl'>Search Summary</Heading>
      </div>
      <div
        style={{
          display: 'flex',
          width: '250px',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '16px',
        }}
      >
        <div style={{ flexGrow: 1 }}>
          <ProgressBar progress={confidence} />
        </div>
        <Tag
          icon={<FaInfoCircle />}
          label={`${confidence}% Confidence`}
          variant='info-grey'
        />
      </div>
      <Heading size='lg'>
        Returned results for publications WRI has published on: {`${query}.`}
      </Heading>
      <Box style={{ padding: '1rem 0' }}>
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
            “between 2019–2025”, and a more specific topic, for example interest
            in policies or outcomes related to compact urban growth
          </List.Item>
        </List.Root>
      </Box>
    </section>
    <ResultsTable data={tableData} />
  </main>
  )
}

export default ResultsPage
