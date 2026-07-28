/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import AdminLayout from '@/app/admin/layout'

// Stub Next.js router hooks
jest.mock('next/navigation', () => ({
  usePathname: () => '/admin/documents',
  useRouter: () => ({ push: jest.fn() }),
}))

// Stub the /api/admin/auth/me fetch to return an admin identity
beforeAll(() => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ identity: { username: 'admin', role: 'admin' } }),
  }) as any
})

describe('AdminLayout branding', () => {
  const wrap = (children: React.ReactNode) => (
    <ChakraProvider>
      <AdminLayout>{children}</AdminLayout>
    </ChakraProvider>
  )
  it('renders an AskWRI branded header/wordmark', () => {
    render(wrap(<div>page content</div>))
    // The layout must show an AskWRI wordmark/logo (appears in sidebar + footer).
    expect(screen.getAllByText(/AskWRI/i).length).toBeGreaterThan(0)
  })

  it('renders the nav links', () => {
    render(wrap(<div>page content</div>))
    expect(screen.getAllByText(/Review queue/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Upload/i).length).toBeGreaterThan(0)
  })

  it('renders a footer with a link to the admin guide', () => {
    const { container } = render(wrap(<div>page content</div>))
    // A footer should link to the admin guide documentation.
    const links = container.querySelectorAll('a')
    const hasGuideLink = Array.from(links).some((a) =>
      /guide|help|docs/i.test(a.textContent || ''),
    )
    expect(hasGuideLink).toBe(true)
  })
})
