/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import LoginPage from '@/app/admin/login/page'

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    refresh: jest.fn(),
  }),
  useSearchParams: () => ({ get: () => null }),
}))

it('login inputs are associated with visible labels', () => {
  render(
    <ChakraProvider>
      <LoginPage />
    </ChakraProvider>,
  )
  expect(screen.getByLabelText('Username')).toBeTruthy()
  expect(screen.getByLabelText('Password')).toBeTruthy()
})
