import { render, screen, fireEvent, act } from '@testing-library/react'
import { Tooltip } from '@/app/admin/components/Tooltip'

// jsdom has no layout engine — getBoundingClientRect returns all zeros, so the
// flip would never trigger on its own. Drive the one input the decision reads.
function placeTriggerAt(left: number, viewportWidth: number) {
  window.innerWidth = viewportWidth
  Element.prototype.getBoundingClientRect = function () {
    return {
      left,
      top: 0,
      right: left,
      bottom: 0,
      width: 0,
      height: 0,
      x: left,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  }
}

const panelOf = (help: string) => screen.getByText(help)

describe('Tooltip edge placement', () => {
  const originalRect = Element.prototype.getBoundingClientRect
  const originalWidth = window.innerWidth
  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalRect
    window.innerWidth = originalWidth
  })

  // The regression: these triggers sit in a right-aligned status column, where
  // a 280px panel anchored to the trigger's LEFT edge ran off the window and
  // was only partly readable.
  it('anchors right when a left-anchored panel would overflow the viewport', () => {
    placeTriggerAt(1200, 1280) // 1200 + 280 + 8 > 1280
    render(<Tooltip help='near the right edge'>label</Tooltip>)
    act(() => {
      fireEvent.focus(screen.getByRole('button'))
    })
    const panel = panelOf('near the right edge')
    expect(panel).toHaveStyle({ right: '0px' })
    expect(panel.style.left).toBe('')
  })

  it('anchors left when there is room', () => {
    placeTriggerAt(100, 1280)
    render(<Tooltip help='plenty of room'>label</Tooltip>)
    act(() => {
      fireEvent.focus(screen.getByRole('button'))
    })
    const panel = panelOf('plenty of room')
    expect(panel).toHaveStyle({ left: '0px' })
    expect(panel.style.right).toBe('')
  })

  it('clamps width to the viewport so a narrow window cannot overflow', () => {
    placeTriggerAt(10, 320)
    render(<Tooltip help='narrow window'>label</Tooltip>)
    act(() => {
      fireEvent.focus(screen.getByRole('button'))
    })
    expect(panelOf('narrow window').style.maxWidth).toContain('100vw')
  })
})
