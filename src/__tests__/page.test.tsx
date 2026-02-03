
import { render, screen } from '@testing-library/react'
import HomePage from '@/app/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
    refresh: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => ({
    get: () => null,
  }),
}))

describe('Home Page', () => {
  it('renders the Ask WRI heading', () => {
    render(
      <ChakraProvider>
        <HomePage />
      </ChakraProvider>,
    )

    expect(
      screen.getByRole('heading', { name: /Discover WRI publications/i }),
    ).toBeInTheDocument()
  })
})
