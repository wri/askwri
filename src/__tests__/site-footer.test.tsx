import { render, screen } from '@testing-library/react'

const mockPathname = jest.fn()
jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
}))
jest.mock('@/app/components/Footer', () => ({
  Footer: () => <div data-testid='wri-footer'>public footer</div>,
}))

import { SiteFooter } from '@/app/components/Footer/SiteFooter'

// The admin shell renders its own footer. Rendering the public one too put it
// ON TOP of the admin footer, which garbled it and swallowed clicks on the
// "Admin Guide" link.
describe('SiteFooter', () => {
  it.each([
    '/admin',
    '/admin/upload',
    '/admin/documents/abc-123',
    '/admin/review',
  ])('is suppressed on %s', (path) => {
    mockPathname.mockReturnValue(path)
    render(<SiteFooter />)
    expect(screen.queryByTestId('wri-footer')).not.toBeInTheDocument()
  })

  it.each(['/', '/results', '/about'])('still renders on %s', (path) => {
    mockPathname.mockReturnValue(path)
    render(<SiteFooter />)
    expect(screen.getByTestId('wri-footer')).toBeInTheDocument()
  })

  it('does not crash when the pathname is unavailable', () => {
    mockPathname.mockReturnValue(null)
    render(<SiteFooter />)
    expect(screen.getByTestId('wri-footer')).toBeInTheDocument()
  })
})
