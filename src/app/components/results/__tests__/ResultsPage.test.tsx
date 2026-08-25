import { render, screen, fireEvent } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import ResultsPage from '@/app/components/results'

// Navbar pulls styles/fonts that aren't needed for this render; stub it.
jest.mock('@/app/components/results/Navbar', () => ({
  __esModule: true,
  default: () => <div />,
}))

const props = (queryUnderstanding: any, onRemoveFacet = jest.fn()) => ({
  query: 'hydrogen since 2020',
  data: [],
  ops: {
    index_version: '1',
    prompt_version: '1',
    cost_usd: 0,
    energy_gco2e: 0,
  },
  alignment: { insights: [] },
  alignLoading: false,
  queryUnderstanding,
  onRemoveFacet,
  onApplySuggestion: jest.fn(),
})

describe('results component — interpretation line placement (design §3)', () => {
  it('renders the hard-facet chip and removes it on ✕ (re-query with remaining facets)', () => {
    const onRemove = jest.fn()
    const understanding = {
      facets: [
        { facet: 'year_min', value: '2020', action: 'hard', source: 'parser' },
      ],
      suggestions: [],
    }
    render(
      <ChakraProvider>
        <ResultsPage {...props(understanding, onRemove)} />
      </ChakraProvider>,
    )
    // The chip is present in the docs-present path (not only empty state).
    expect(screen.getByText('2020–present')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: /Remove 2020–present filter/i }),
    )
    // Removing fires onRemoveFacet with the chip — page.tsx turns this into
    // a re-query with the remaining facets (explicit = auto-detection off).
    expect(onRemove).toHaveBeenCalledWith({
      facet: 'year_min',
      value: '2020',
      label: '2020–present',
    })
  })

  it('renders nothing when there are no hard facets and no suggestion', () => {
    render(
      <ChakraProvider>
        <ResultsPage {...props({ facets: [], suggestions: [] })} />
      </ChakraProvider>,
    )
    expect(screen.queryByText(/Showing:/)).not.toBeInTheDocument()
  })
})
