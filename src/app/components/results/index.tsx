'use client'

import { useState, FC } from 'react'
import { Heading, Box, List, Text, Spinner } from '@chakra-ui/react'
import {
  Button,
  Tag,
  Tooltip as DS_Tooltip,
  getThemedColor,
} from '@worldresources/wri-design-systems'
import { FaInfoCircle } from 'react-icons/fa'
import { HiCurrencyDollar } from 'react-icons/hi2'
import { AiFillThunderbolt } from 'react-icons/ai'
import { TfiThought } from 'react-icons/tfi'
import { AiIcon } from '../icons/AiIcon'
import Navbar from './Navbar'
import ResultsTable from './ResultsTable'
import { ResultsPageProps } from './types'
import AIProcessModalContent from './AIProcessModal'
import ImproveSearchModal from './ImproveSearchModal'
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
  const [improveSearchModalOpen, setImproveSearchModalOpen] = useState(false)
  const tableData = data

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
                  as='div'
                  size='small'
                  label={`${ops?.energy_gco2e?.toFixed(2) ?? '0'} gCO2e`}
                  aria-label='Carbon equivalent of search'
                  onClick={() => {}}
                />
              </Tooltip>
              <Tooltip content='Cost of credits used in search'>
                <Button
                  as='div'
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
          {/*
          TODO: hidding the "Improve Search" button until we decide on wether to implement this feature.
          <Button
            leftIcon={<FaSearch />}
            variant='secondary'
            size='small'
            label='Improve Search'
            aria-label='Improve Search'
            onClick={() => setImproveSearchModalOpen(true)}
          /> */}
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
          {alignLoading || !alignment || !alignment.insights?.length ? (
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
            <List.Root>
              {alignment.insights.map((insight, idx) => (
                <List.Item key={`insight-${idx}`}>{insight}</List.Item>
              ))}
            </List.Root>
          )}
        </Box>
        {!alignLoading && alignment?.alignment && (
          <div
            style={{
              width: '280px',
              alignItems: 'center',
              marginBottom: '16px',
            }}
          >
            <Tooltip content='AI assessment of how well the retrieved sources address the query and whether important gaps or risks remain.'>
              <Tag
                icon={<FaInfoCircle />}
                label={`Alignment: ${alignment.alignment}`}
                variant='info-white'
              />
            </Tooltip>
          </div>
        )}
      </section>
      <ResultsTable
        query={query}
        data={tableData}
        docSummaryLoading={docSummaryLoading}
        docWhyLoading={docWhyLoading}
        onExportBib={onExportBib}
      />
      <AIProcessModalContent
        transcript={transcript}
        query={query}
        aiProcessModalOpen={aiProcessModalOpen}
        setAiProcessModalOpen={setAiProcessModalOpen}
      />
      {/*
      TODO: hidding the "Improve Search" button until we decide on wether to implement this feature.
      <ImproveSearchModal
        cost_usd={ops?.cost_usd ?? 0}
        energy_gco2e={ops?.energy_gco2e ?? 0}
        suggestions={alignment?.insights || []}
        initialQuery={query}
        improveSearchModalOpen={improveSearchModalOpen}
        setImproveSearchModalOpen={setImproveSearchModalOpen}
      />
      */}
    </main>
  )
}

export default ResultsPage
