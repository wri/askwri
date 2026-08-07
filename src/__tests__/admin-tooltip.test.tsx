/** @jest-environment jsdom */
import { render, screen, fireEvent } from '@testing-library/react'
import { Tooltip } from '@/app/admin/components/Tooltip'

describe('Tooltip component', () => {
  it('renders its trigger text and a discoverable ? marker', () => {
    const { container } = render(
      <Tooltip help='The authors as listed in the source CSV.'>
        Authors
      </Tooltip>,
    )
    expect(screen.getByText('Authors')).toBeTruthy()
    expect(container.textContent).toContain('?')
  })

  it('exposes the trigger as a real button that describes itself via the tooltip', () => {
    render(<Tooltip help='The DOI link.'>DOI</Tooltip>)
    const trigger = screen.getByRole('button')
    const described = trigger.getAttribute('aria-describedby')
    expect(described).toBeTruthy()
    const tip = document.getElementById(described as string)
    expect(tip?.getAttribute('role')).toBe('tooltip')
    expect(tip?.textContent).toBe('The DOI link.')
  })

  it('does NOT use a native title attribute (it double-announces)', () => {
    const { container } = render(<Tooltip help='No title here.'>Date</Tooltip>)
    expect(container.querySelector('[title]')).toBeNull()
  })

  it('shows the tooltip on focus and hides it on blur', () => {
    render(<Tooltip help='Shown on keyboard focus.'>Field</Tooltip>)
    const trigger = screen.getByRole('button')
    const tip = document.getElementById(
      trigger.getAttribute('aria-describedby') as string,
    ) as HTMLElement
    expect(tip.style.display).toBe('none')
    fireEvent.focus(trigger)
    expect(tip.style.display).toBe('block')
    fireEvent.blur(trigger)
    expect(tip.style.display).toBe('none')
  })

  it('shows the tooltip on hover and hides it on mouse leave', () => {
    render(<Tooltip help='Shown on hover.'>Field</Tooltip>)
    const trigger = screen.getByRole('button')
    const tip = document.getElementById(
      trigger.getAttribute('aria-describedby') as string,
    ) as HTMLElement
    fireEvent.mouseEnter(trigger)
    expect(tip.style.display).toBe('block')
    fireEvent.mouseLeave(trigger)
    expect(tip.style.display).toBe('none')
  })

  it('stays open on a real tap (focus then click) and dismisses on Escape', () => {
    // A real touch tap fires focus THEN click. Click must be idempotent-open,
    // not a toggle, or the first tap would flash the tooltip shut.
    render(<Tooltip help='Tap to open.'>Field</Tooltip>)
    const trigger = screen.getByRole('button')
    const tip = document.getElementById(
      trigger.getAttribute('aria-describedby') as string,
    ) as HTMLElement
    fireEvent.focus(trigger)
    expect(tip.style.display).toBe('block')
    fireEvent.click(trigger)
    expect(tip.style.display).toBe('block')
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(tip.style.display).toBe('none')
  })

  it('opens on a plain click', () => {
    render(<Tooltip help='Click to open.'>Field</Tooltip>)
    const trigger = screen.getByRole('button')
    const tip = document.getElementById(
      trigger.getAttribute('aria-describedby') as string,
    ) as HTMLElement
    expect(tip.style.display).toBe('none')
    fireEvent.click(trigger)
    expect(tip.style.display).toBe('block')
  })
})
