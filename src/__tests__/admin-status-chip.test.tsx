import { render, screen } from '@testing-library/react'
import { StatusChip } from '../app/admin/components/StatusChip'

describe('StatusChip', () => {
  it('renders the status with a plain-language tooltip', () => {
    render(<StatusChip status='needs_review' />)
    const chip = screen.getByText('needs_review')
    expect(chip.closest('[title]')!.getAttribute('title')).toMatch(/review/i)
  })

  it('renders unknown statuses without a tooltip crash', () => {
    render(<StatusChip status='weird' />)
    expect(screen.getByText('weird')).toBeInTheDocument()
  })
})
