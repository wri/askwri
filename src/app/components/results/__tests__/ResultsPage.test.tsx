import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import ResultsPage from '@/app/components/results'

let currentParams = 'q=hydrogen'
const routerPush = jest.fn()

jest.mock('../filterOptions', () => ({
  getLanguageOptions: jest.fn().mockResolvedValue([
    { name: 'en', value: 'en', children: 'English' },
    { name: 'es', value: 'es', children: 'Spanish' },
  ]),
  getOfficeOptions: jest
    .fn()
    .mockResolvedValue([
      { name: 'wri-india', value: 'WRI India', children: 'India' },
    ]),
}))

// Navbar pulls styles/fonts that aren't needed for this render; stub it.
jest.mock('@/app/components/results/Navbar', () => ({
  __esModule: true,
  default: () => <div />,
}))

// ResultsPage reads the URL (office filter) and pushes params on apply/remove.
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
  useSearchParams: () => new URLSearchParams(currentParams),
}))

beforeEach(() => {
  currentParams = 'q=hydrogen'
  routerPush.mockClear()
})

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

describe('results date filter navigation', () => {
  it('applies dates alongside offices and languages in one navigation', async () => {
    currentParams =
      'q=hydrogen&office=WRI+India&language=en&language=es&date_min=2020-06-01&date_max=2020-06-30&tracking=1'
    render(
      <ChakraProvider>
        <ResultsPage {...props({ facets: [] })} />
      </ChakraProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open filter panel' }))
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'India' })).toBeChecked(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(routerPush).toHaveBeenCalledTimes(1)
    const params = new URL(routerPush.mock.calls[0][0], 'http://localhost')
      .searchParams
    expect(params.get('q')).toBe('hydrogen')
    expect(params.getAll('office')).toEqual(['WRI India'])
    expect(params.getAll('language')).toEqual(['en', 'es'])
    expect(params.get('date_min')).toBe('2020-06-01')
    expect(params.get('date_max')).toBe('2020-06-30')
    expect(params.get('tracking')).toBe('1')
  })

  it('clears dates and other filters without removing the query', async () => {
    currentParams =
      'q=hydrogen&office=WRI+India&language=es&date_min=2020-06-01&date_max=2020-06-30'
    render(
      <ChakraProvider>
        <ResultsPage {...props({ facets: [] })} />
      </ChakraProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open filter panel' }))
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'India' })).toBeChecked(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))

    expect(routerPush).toHaveBeenCalledTimes(1)
    expect(routerPush).toHaveBeenCalledWith('/results?q=hydrogen')
  })
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
