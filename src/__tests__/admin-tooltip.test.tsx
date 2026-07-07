/** @jest-environment jsdom */
import { render, screen, fireEvent } from '@testing-library/react'
import { Tooltip } from '@/app/admin/components/Tooltip'

describe('Tooltip component', () => {
  it('renders its trigger text', () => {
    render(<Tooltip help='The authors of the document, as listed in the source CSV.'>Authors</Tooltip>)
    expect(screen.getByText('Authors')).toBeTruthy()
  })

  it('exposes the help text via title attribute (accessible without hover)', () => {
    render(<Tooltip help='The DOI link, e.g. https://doi.org/10.x/y'>DOI</Tooltip>)
    // The title attribute makes the help visible on hover and to screen readers.
    // We find the element wrapping the trigger text.
    const trigger = screen.getByText('DOI')
    // Walk up to find the element with the title attribute.
    let el: HTMLElement | null = trigger
    while (el && !el.getAttribute('title')) {
      el = el.parentElement
    }
    expect(el?.getAttribute('title')).toBe('The DOI link, e.g. https://doi.org/10.x/y')
  })

  it('renders an info marker so the tooltip is discoverable', () => {
    const { container } = render(
      <Tooltip help='The full publication date (YYYY-MM-DD).'>Date published</Tooltip>,
    )
    // A small "?" marker indicates help is available.
    expect(container.textContent).toContain('?')
  })
})
