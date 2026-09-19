import { render, screen } from '@testing-library/react'
import ExpertsHelpPage from '@/app/experts/help/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => '/experts/help',
}))

const renderPage = () =>
  render(
    <ChakraProvider>
      <ExpertsHelpPage />
    </ChakraProvider>,
  )

describe('/experts/help', () => {
  it('covers the four sections in reading order', () => {
    renderPage()
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent)
    expect(headings).toEqual([
      'How to use it',
      'How to read the results',
      'How the score works',
      'What it cannot tell you',
    ])
  })

  it('says the counts are over works, so a translation is not a second document', () => {
    // The evidence panel reads "6 of 27 documents match". 27 is the person's
    // WORKS; an original and its confirmed translations collapse to one. That
    // number gets questioned, so the answer has to be written down somewhere.
    renderPage()
    expect(screen.getByText(/translation/i)).toBeInTheDocument()
    expect(screen.getByTestId('help-works-counting')).toHaveTextContent(
      /counts works, not files/i,
    )
  })

  it('says NOT appearing is not evidence of missing expertise', () => {
    // The reputational one. This is a ranked list of named colleagues, and
    // someone will read an absence as a judgement.
    renderPage()
    expect(screen.getByTestId('help-absence')).toHaveTextContent(
      /does not mean they lack that expertise/i,
    )
  })

  it('says the weights are untuned prototype defaults', () => {
    renderPage()
    expect(screen.getByTestId('help-untuned')).toHaveTextContent(
      /have not been tuned/i,
    )
  })

  it('explains the evidence/topic blend without hardcoding corpus statistics', () => {
    // Numbers like "145 of 201 documents" drift and become the stale-claim
    // problem. The explanation stays qualitative on purpose.
    renderPage()
    expect(screen.getByTestId('help-blend')).toHaveTextContent(/70/)
    expect(screen.getByTestId('help-blend')).toHaveTextContent(/30/)
    const body = document.body.textContent || ''
    expect(body).not.toMatch(/\b\d{3} (?:of|documents)\b/)
  })

  it('offers a way back to the search', () => {
    renderPage()
    expect(
      screen.getByRole('link', { name: /back to experts/i }),
    ).toHaveAttribute('href', '/experts')
  })

  it('stays unlisted', () => {
    renderPage()
    expect(
      document.querySelector('meta[name="robots"][content="noindex"]'),
    ).not.toBeNull()
  })
})
