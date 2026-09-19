import { fireEvent, render, screen } from '@testing-library/react'
import Navbar from '@/app/components/results/Navbar'

const push = jest.fn()
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/experts',
}))

// The real WriNavbar is responsive and collapses to a menu button under jsdom's
// zero-width viewport, so its utilitySection never reaches the DOM. Mock the
// third-party shell only: what is under test is which destination WE wire.
jest.mock('@worldresources/wri-design-systems', () => ({
  Navbar: ({ utilitySection }: any) => <nav>{utilitySection}</nav>,
  Button: ({ children, onClick }: any) => (
    <button onClick={onClick}>{children}</button>
  ),
}))

beforeEach(() => push.mockClear())

describe('Navbar "New search"', () => {
  it('returns to the research home by default', () => {
    render(<Navbar query='buses' />)
    fireEvent.click(screen.getByRole('button', { name: 'New search' }))
    expect(push).toHaveBeenCalledWith('/')
  })

  it('stays inside experts mode when given that destination (spec §7)', () => {
    // The shared component hard-coded '/', so the one obvious way to start over
    // dropped a staff user out of /experts entirely.
    render(<Navbar query='buses' newSearchHref='/experts' />)
    fireEvent.click(screen.getByRole('button', { name: 'New search' }))
    expect(push).toHaveBeenCalledWith('/experts')
  })
})
