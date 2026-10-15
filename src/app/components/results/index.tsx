'use client'

import { FC, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
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
import { AiIcon } from '../icons/AiIcon'
import Navbar from './Navbar'
import ResultsTable from './ResultsTable'
import FilterPanel from './FilterPanel'
import { formatCO2, formatCost } from '../../utils/utils'
import { ResultsPageProps } from './types'
import {
  InterpretationLine,
  appliedChips,
  suggestedChips,
} from './InterpretationLine'
import '../../styles.css'

const Tooltip = DS_Tooltip as FC<any> // temporary fix to resolve type issues with Tooltip component from wri-design-systems

const ResultsPage = ({
  data = [],
  query,
  docSummaryLoading,
  docWhyLoading,
  onExportBib,
  ops,
  alignment,
  alignLoading,
  queryUnderstanding,
  onRemoveFacet,
  onApplyFacet,
  onApplySuggestion,
}: ResultsPageProps) => {
  const tableData = data
  const hardChips = appliedChips(queryUnderstanding?.facets)
  const router = useRouter()
  const searchParams = useSearchParams()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const selectedOffices = searchParams?.getAll('office') ?? []
  const selectedLanguages = searchParams?.getAll('language') ?? []
  const selectedDates = [
    searchParams?.get('date_min'),
    searchParams?.get('date_max'),
  ].filter((value): value is string => Boolean(value))

  // One navigation for both facets: two router.push calls in the same tick
  // race in the App Router and the second cancels the first.
  const applyFilters = (
    offices: string[],
    languages: string[],
    dates: string[],
  ) => {
    const params = new URLSearchParams(searchParams?.toString())
    params.delete('office')
    for (const office of offices) params.append('office', office)
    params.delete('language')
    for (const language of languages) params.append('language', language)
    params.delete('date_min')
    params.delete('date_max')
    if (dates[0]) params.set('date_min', dates[0])
    if (dates[1]) params.set('date_max', dates[1])
    router.push(`/results?${params.toString()}`)
  }

  return (
    <main className='gradient-background' style={{ paddingBottom: '57px' }}>
      <Navbar query={query} />
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
                  label={formatCO2(ops?.energy_gco2e)}
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
                  label={formatCost(ops?.cost_usd)}
                  aria-label='Cost of credits used in search'
                  onClick={() => {}}
                />
              </Tooltip>
            </>
          )}
        </div>
      </section>
      {/* Interpretation line sits in the content column (design §3): aligned
        with the Overview/results below, not full-width. */}
      <div style={{ padding: '0 2rem', maxWidth: '800px' }}>
        <InterpretationLine
          chips={hardChips}
          suggested={suggestedChips(queryUnderstanding?.facets, hardChips)}
          suggestion={
            queryUnderstanding?.suggestions?.find((s) => s.type === 'spelling')
              ?.text ?? null
          }
          onRemoveChip={(chip) => onRemoveFacet?.(chip)}
          onApplyChip={(chip) => onApplyFacet?.(chip)}
          onApplySuggestion={(text) => onApplySuggestion?.(text)}
        />
      </div>
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
        onOpenFilters={() => setFiltersOpen(true)}
        filtersOpen={filtersOpen}
      />
      <FilterPanel
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        selectedOffices={selectedOffices}
        selectedLanguages={selectedLanguages}
        selectedDates={selectedDates}
        onApply={applyFilters}
      />
    </main>
  )
}

export default ResultsPage
