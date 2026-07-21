import { render, screen, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import { Flash } from '@/app/admin/components/Flash'

describe('Flash', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  it('renders nothing when notice and error are both null', () => {
    const { container } = render(
      <Flash notice={null} error={null} onDismiss={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a notice inside an aria-live polite status region', () => {
    render(<Flash notice='Saved.' error={null} onDismiss={() => {}} />)
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByText('Saved.')).toBeInTheDocument()
  })

  it('auto-dismisses a notice after 6 seconds', () => {
    const onDismiss = jest.fn()
    render(<Flash notice='Saved.' error={null} onDismiss={onDismiss} />)
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => {
      jest.advanceTimersByTime(6000)
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does NOT auto-dismiss an error', () => {
    const onDismiss = jest.fn()
    render(<Flash notice={null} error='Boom.' onDismiss={onDismiss} />)
    act(() => {
      jest.advanceTimersByTime(6000)
    })
    expect(onDismiss).not.toHaveBeenCalled()
    expect(screen.getByText('Boom.')).toBeInTheDocument()
  })

  it('shows the error when both notice and error are set (error wins, no auto-dismiss)', () => {
    const onDismiss = jest.fn()
    render(<Flash notice='Saved.' error='Boom.' onDismiss={onDismiss} />)
    expect(screen.getByText('Boom.')).toBeInTheDocument()
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument()
    act(() => {
      jest.advanceTimersByTime(6000)
    })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('calls onDismiss when the close button is clicked', () => {
    const onDismiss = jest.fn()
    render(<Flash notice='Saved.' error={null} onDismiss={onDismiss} />)
    screen.getByRole('button', { name: /dismiss/i }).click()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
