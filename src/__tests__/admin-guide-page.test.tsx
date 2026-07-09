import { render, screen } from '@testing-library/react'
import GuidePage from '../app/admin/guide/page'

describe('Admin guide page', () => {
  it('renders the core sections', () => {
    render(<GuidePage />)
    expect(
      screen.getByRole('heading', { name: /admin guide/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/typical workflow/i)).toBeInTheDocument()
    expect(screen.getByText(/document statuses/i)).toBeInTheDocument()
    expect(screen.getByText(/who last set each field/i)).toBeInTheDocument()
  })

  it('renders every status from the shared glossary', () => {
    render(<GuidePage />)
    for (const s of [
      'draft',
      'processing',
      'needs_review',
      'searchable',
      'withdrawn',
      'error',
    ]) {
      expect(screen.getByText(s)).toBeInTheDocument()
    }
  })
})
