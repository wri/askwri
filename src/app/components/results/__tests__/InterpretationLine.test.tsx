import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import {
  InterpretationLine,
  facetChipLabel,
  appliedChips,
  suggestedChips,
} from '../InterpretationLine'

describe('facetChipLabel', () => {
  it('formats year and language facets for humans', () => {
    expect(facetChipLabel('year_min', '2022')).toBe('2022–present')
    expect(facetChipLabel('year_max', '2019')).toBe('up to 2019')
    expect(facetChipLabel('language', 'es')).toBe('Spanish')
    expect(facetChipLabel('program', 'WRR')).toBe('WRR')
  })
})

describe('InterpretationLine', () => {
  const chips = [{ facet: 'year_min', value: '2022', label: '2022–present' }]

  it('renders nothing when there is nothing to say', () => {
    const { container } = render(
      <InterpretationLine
        chips={[]}
        suggestion={null}
        onRemoveChip={jest.fn()}
        onApplySuggestion={jest.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders removable chips and fires onRemoveChip', () => {
    const onRemove = jest.fn()
    render(
      <ChakraProvider>
        <InterpretationLine
          chips={chips}
          suggestion={null}
          onRemoveChip={onRemove}
          onApplySuggestion={jest.fn()}
        />
      </ChakraProvider>,
    )
    expect(screen.getByText('2022–present')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Remove 2022–present filter'))
    expect(onRemove).toHaveBeenCalledWith(chips[0])
  })

  it('renders a did-you-mean suggestion and fires onApplySuggestion', () => {
    const onApply = jest.fn()
    render(
      <InterpretationLine
        chips={[]}
        suggestion='freight decarbonization'
        onRemoveChip={jest.fn()}
        onApplySuggestion={onApply}
      />,
    )
    fireEvent.click(screen.getByText('freight decarbonization'))
    expect(onApply).toHaveBeenCalledWith('freight decarbonization')
  })

  it('offers a suggested facet and applies it on click, never removably', () => {
    const onApplyChip = jest.fn()
    const suggested = [
      { facet: 'year_min', value: '2023', label: '2023–present' },
    ]
    render(
      <ChakraProvider>
        <InterpretationLine
          chips={[]}
          suggested={suggested}
          suggestion={null}
          onRemoveChip={jest.fn()}
          onApplyChip={onApplyChip}
          onApplySuggestion={jest.fn()}
        />
      </ChakraProvider>,
    )
    expect(screen.getByText('Suggested:')).toBeInTheDocument()
    // A suggestion is not applied, so it must not offer removal.
    expect(screen.queryByLabelText('Remove 2023–present filter')).toBeNull()
    fireEvent.click(screen.getByLabelText('Apply 2023–present filter'))
    expect(onApplyChip).toHaveBeenCalledWith(suggested[0])
  })
})

describe('chip selection', () => {
  const facets = [
    { facet: 'year_min', value: '2022', action: 'hard' },
    { facet: 'year_min', value: '2022', action: 'suggest' },
    { facet: 'language', value: 'es', action: 'suggest' },
  ]

  it('takes only applied facets as chips', () => {
    expect(appliedChips(facets)).toEqual([
      { facet: 'year_min', value: '2022', label: '2022–present' },
    ])
  })

  it('drops a suggestion the applied chips already cover', () => {
    const applied = appliedChips(facets)
    expect(suggestedChips(facets, applied)).toEqual([
      { facet: 'language', value: 'es', label: 'Spanish' },
    ])
  })
})
