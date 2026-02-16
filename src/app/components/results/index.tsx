'use client'

import { useState, FC } from 'react'
import { Heading, Box, List, Text, Spinner } from '@chakra-ui/react'
import {
  Button,
  Tag,
  Tooltip as DS_Tooltip,
  getThemedColor,
  Modal,
} from '@worldresources/wri-design-systems'
import { FaInfoCircle, FaSearch } from 'react-icons/fa'
import { HiCurrencyDollar } from 'react-icons/hi2'
import { AiFillThunderbolt } from 'react-icons/ai'
import { TfiThought } from 'react-icons/tfi'
import { AiIcon } from '../icons/AiIcon'
import Navbar from './Navbar'
import ResultsTable from './ResultsTable'
import { ResultsPageProps } from './types'
import { AIProcessModalContent, aiProcessModalHeader } from './AIProcessModal'
import '../../styles.css'

const Tooltip = DS_Tooltip as FC<any> // temporary fix to resolve type issues with Tooltip component from wri-design-systems

const ResultsPage = ({
  data = [],
  query,
  docSummaryLoading,
  docWhyLoading,
  onExportBib,
  ops,
  transcript,
  alignment,
  alignLoading,
}: ResultsPageProps) => {
  const [aiProcessModalOpen, setAiProcessModalOpen] = useState(false)
  const tableData = data

  const confidence = (alignment?.confidence ?? 0) * 100

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
          {!alignLoading && (
            <>
              <Tooltip content='Carbon equivalent of search'>
                <Button
                  leftIcon={<AiFillThunderbolt />}
                  variant='borderless'
                  size='small'
                  label={`${ops?.energy_gco2e?.toFixed(2) ?? '0'} gCO2e`}
                  aria-label='Carbon equivalent of search'
                  onClick={() => {}}
                />
              </Tooltip>
              <Tooltip content='Cost of credits used in search'>
                <Button
                  leftIcon={<HiCurrencyDollar />}
                  variant='borderless'
                  size='small'
                  label={`$${ops?.cost_usd?.toFixed(2) ?? '0.00'}`}
                  aria-label='Cost of credits used in search'
                  onClick={() => {}}
                />
              </Tooltip>
            </>
          )}
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
            onClick={() => setAiProcessModalOpen(true)}
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
          {alignLoading ||
          !alignment ||
          (!alignment.caveats?.length &&
            !alignment.risks?.length &&
            !alignment.suggestions?.length &&
            !alignment.coverage?.length) ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '20px',
              }}
            >
              <Spinner size='md' color={getThemedColor('primary', 500)} />
            </div>
          ) : (
            <>
              {alignment?.caveats && alignment.caveats.length > 0 && (
                <>
                  <Text
                    fontWeight='bold'
                    marginTop='1rem'
                    marginBottom='0.5rem'
                  >
                    Caveats & reservations
                  </Text>
                  <List.Root>
                    {alignment.caveats.map((caveat) => (
                      <List.Item key={`caveat-${caveat}`}>{caveat}</List.Item>
                    ))}
                  </List.Root>
                </>
              )}
              {alignment?.risks && alignment.risks.length > 0 && (
                <>
                  <Text
                    fontWeight='bold'
                    marginTop='1rem'
                    marginBottom='0.5rem'
                  >
                    Risks & failure modes
                  </Text>
                  <List.Root>
                    {alignment.risks.map((risk) => (
                      <List.Item key={`risk-${risk}`}>{risk}</List.Item>
                    ))}
                  </List.Root>
                </>
              )}
              {alignment?.suggestions && alignment.suggestions.length > 0 && (
                <>
                  <Text
                    fontWeight='bold'
                    marginTop='1rem'
                    marginBottom='0.5rem'
                  >
                    Suggestions for query improvement
                  </Text>
                  <List.Root>
                    {alignment.suggestions.map((suggestion) => (
                      <List.Item key={`suggestion-${suggestion}`}>
                        {suggestion}
                      </List.Item>
                    ))}
                  </List.Root>
                </>
              )}
              {alignment?.coverage && alignment.coverage.length > 0 && (
                <>
                  <Text
                    fontWeight='bold'
                    marginTop='1rem'
                    marginBottom='0.5rem'
                  >
                    Coverage &amp; correspondence
                  </Text>
                  <List.Root>
                    {alignment.coverage.map((item) => (
                      <List.Item key={`coverage-${item}`}>{item}</List.Item>
                    ))}
                  </List.Root>
                </>
              )}
            </>
          )}
        </Box>
        {!alignLoading && alignment?.confidence && (
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
        )}
      </section>
      <ResultsTable
        data={tableData}
        docSummaryLoading={docSummaryLoading}
        docWhyLoading={docWhyLoading}
        onExportBib={onExportBib}
      />
      <Modal
        header={aiProcessModalHeader}
        content={
          <AIProcessModalContent transcript={transcript} query={query} />
        }
        size='xlarge'
        blocking={false}
        open={aiProcessModalOpen}
        onClose={() => setAiProcessModalOpen(false)}
      />
    </main>
  )
}

export default ResultsPage
