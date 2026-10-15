'use client'

import { Box, DatePicker, Flex, Heading, parseDate } from '@chakra-ui/react'
import {
  Button,
  CheckboxList,
  Modal,
  Select,
  getThemedBorderWidth,
  getThemedColor,
  getThemedRadius,
  getThemedSpacing,
  getThemedFontSize,
  getThemedLineHeight,
} from '@worldresources/wri-design-systems'
import { LuCalendar } from 'react-icons/lu'
import { useEffect, useState } from 'react'
import {
  getLanguageOptions,
  getOfficeOptions,
  type FilterOption,
} from './filterOptions'

const relevanceItems = [
  { label: 'Partial', value: 'partial' },
  { label: 'Weak', value: 'weak' },
  { label: 'Strong', value: 'strong' },
]

const FilterSection = ({ children }: { children: React.ReactNode }) => (
  <Box
    padding={getThemedSpacing(400)}
    background={getThemedColor('neutral', 100)}
    border={`${getThemedBorderWidth(100)} solid ${getThemedColor('neutral', 300)}`}
    borderRadius={getThemedRadius(200)}
  >
    {children}
  </Box>
)

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      fontWeight: '700',
      fontSize: getThemedFontSize(500),
      color: getThemedColor('neutral', 900),
      lineHeight: getThemedLineHeight(700),
      paddingBottom: getThemedSpacing(400),
    }}
  >
    {children}
  </div>
)

export interface FilterPanelProps {
  open: boolean
  onClose: () => void
  /** Office values currently applied (from the URL), pre-checked in the list. */
  selectedOffices: string[]
  /** Language codes currently applied (from the URL), pre-checked in the list. */
  selectedLanguages: string[]
  selectedDates: string[]
  /** Single navigation for both facets — see index.tsx applyFilters. */
  onApply: (offices: string[], languages: string[], dates: string[]) => void
}

export const FilterPanel = ({
  open,
  onClose,
  selectedOffices,
  selectedLanguages,
  selectedDates,
  onApply,
}: FilterPanelProps) => {
  const [languages, setLanguages] = useState<FilterOption[]>([])
  const [offices, setOffices] = useState<FilterOption[]>([])

  useEffect(() => {
    getLanguageOptions().then(setLanguages)
    getOfficeOptions().then(setOffices)
  }, [])

  if (!open) return null

  // `editedOffices` lives inside the content so that it resets automatically
  // when the modal closes (the content only mounts while open). Keeping it
  // here would require an effect that calls setState on close, which triggers
  // cascading renders.
  return (
    <FilterPanelContent
      onClose={onClose}
      selectedOffices={selectedOffices}
      selectedLanguages={selectedLanguages}
      selectedDates={selectedDates}
      onApply={onApply}
      languages={languages}
      offices={offices}
    />
  )
}

interface FilterPanelContentProps {
  onClose: () => void
  selectedOffices: string[]
  selectedLanguages: string[]
  selectedDates: string[]
  onApply: (offices: string[], languages: string[], dates: string[]) => void
  languages: FilterOption[]
  offices: FilterOption[]
}

const FilterPanelContent = ({
  onClose,
  selectedOffices,
  selectedLanguages,
  selectedDates,
  onApply,
  languages,
  offices,
}: FilterPanelContentProps) => {
  // Checked offices are derived from the URL on mount (see `checkedOffices`
  // below) and owned by local state once the user edits the checkboxes.
  const [editedOffices, setEditedOffices] = useState<string[] | null>(null)
  const [editedLanguages, setEditedLanguages] = useState<string[] | null>(null)
  const [editedDates, setEditedDates] = useState<string[] | null>(null)
  const initialDates = selectedDates.flatMap((value) => {
    try {
      return [parseDate(value)]
    } catch {
      return []
    }
  })

  // URL offices may be accented ("WRI México") while option values are not;
  // match accent-insensitively so the right checkboxes come pre-checked.
  const strip = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
  const checkedOffices =
    editedOffices ??
    offices
      .filter((o) =>
        selectedOffices.some((url) => strip(url) === strip(o.value)),
      )
      .map((o) => o.value)

  const handleOfficeChange = (checked: Record<string, boolean>) => {
    // CheckboxList keys the map by checkbox name (the slug), not value.
    const selected = offices.filter((o) => checked[o.name])
    setEditedOffices(selected.map((o) => o.value))
  }

  const handleLanguageChange = (checked: Record<string, boolean>) => {
    // Language checkbox names are the ISO codes themselves.
    setEditedLanguages(
      languages.filter((l) => checked[l.name]).map((l) => l.value),
    )
  }

  const handleDateChange = (index: number, value: string) => {
    try {
      const isoDate = value ? parseDate(value).toString() : ''
      setEditedDates((previous) => {
        const dates = [...(previous ?? selectedDates)]
        dates[index] = isoDate
        return dates
      })
    } catch {
      return
    }
  }

  const handleApply = () => {
    onApply(
      checkedOffices,
      editedLanguages ?? selectedLanguages,
      editedDates ?? selectedDates,
    )
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      size='medium'
      key={selectedOffices.join('|')}
      header={
        <Flex align='center' justify='space-between'>
          <Heading size='lg'>Filter results</Heading>
        </Flex>
      }
      content={
        <Flex direction='column' gap={getThemedSpacing(300)}>
          <FilterSection>
            <SectionTitle>Publication date</SectionTitle>
            <DatePicker.Root
              selectionMode='range'
              locale='en-CA'
              aria-label='Publication date'
              defaultValue={initialDates}
              format={(date) => date.toString()}
              parse={(value) => {
                try {
                  return parseDate(value)
                } catch {
                  return undefined
                }
              }}
              onValueChange={({ value }) =>
                setEditedDates(value.map((date) => date.toString()))
              }
            >
              <DatePicker.Control>
                <DatePicker.Input
                  index={0}
                  aria-label='Publication start date'
                  placeholder='YYYY-MM-DD'
                  onChange={(event) => handleDateChange(0, event.target.value)}
                />
                <DatePicker.Input
                  index={1}
                  aria-label='Publication end date'
                  placeholder='YYYY-MM-DD'
                  onChange={(event) => handleDateChange(1, event.target.value)}
                />
                <DatePicker.IndicatorGroup>
                  <DatePicker.Trigger aria-label='Open calendar'>
                    <LuCalendar />
                  </DatePicker.Trigger>
                </DatePicker.IndicatorGroup>
              </DatePicker.Control>
              <DatePicker.Positioner>
                <DatePicker.Content>
                  <DatePicker.View view='day'>
                    <DatePicker.Header />
                    <DatePicker.DayTable />
                  </DatePicker.View>
                  <DatePicker.View view='month'>
                    <DatePicker.Header />
                    <DatePicker.MonthTable />
                  </DatePicker.View>
                  <DatePicker.View view='year'>
                    <DatePicker.Header />
                    <DatePicker.YearTable />
                  </DatePicker.View>
                </DatePicker.Content>
              </DatePicker.Positioner>
            </DatePicker.Root>
          </FilterSection>
          <FilterSection>
            <SectionTitle>Relevance</SectionTitle>
            <Select
              label=''
              placeholder='Please select'
              items={relevanceItems}
            />
          </FilterSection>
          <FilterSection>
            <SectionTitle>Available publication language</SectionTitle>
            <CheckboxList
              label=''
              checkboxes={languages}
              defaultValues={languages
                .filter((l) => selectedLanguages.includes(l.value))
                .map((l) => l.name)}
              onCheckedChange={handleLanguageChange}
              hideCheckedCounter
              hideExpandToggle
            />
          </FilterSection>
          <FilterSection>
            <SectionTitle>Country office</SectionTitle>
            <CheckboxList
              label=''
              checkboxes={offices}
              defaultValues={offices
                .filter((o) => checkedOffices.includes(o.value))
                .map((o) => o.name)}
              onCheckedChange={handleOfficeChange}
              hideCheckedCounter
              hideExpandToggle
            />
          </FilterSection>
        </Flex>
      }
      footer={
        <Flex gap={getThemedSpacing(200)}>
          <Button variant='primary' label='Apply' onClick={handleApply} />
          <Button
            variant='secondary'
            label='Clear all'
            onClick={() => {
              setEditedOffices([])
              setEditedLanguages([])
              setEditedDates([])
              onApply([], [], [])
              onClose()
            }}
          />
        </Flex>
      }
    />
  )
}

export default FilterPanel
