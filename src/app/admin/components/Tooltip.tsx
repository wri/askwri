'use client'

import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'

const MAX_WIDTH = 280
// Keep the panel off the very edge of the window.
const VIEWPORT_MARGIN = 8

/**
 * Tooltip / HelpHint — an inline help marker with a keyboard-, touch-, and
 * screen-reader-reachable tooltip.
 *
 * Same API as before: <Tooltip help='…'>label</Tooltip>. The trigger is a real
 * <button> (natively focusable — no tabIndex, no role) wrapping ONLY the label
 * text + a "?" marker. The help text is a role='tooltip' popover, shown on
 * hover, focus, and tap, dismissed on blur/Escape. Click is idempotent-open
 * (not a toggle): a real tap fires focus (open) then click — a toggle would
 * flash the tooltip shut on the first tap. Blur/Escape already close it.
 * Per WAI-ARIA tooltip guidance. The native `title` is intentionally dropped
 * (it double-announces). children MUST be plain text — never interactive nodes.
 */
export const Tooltip = ({
  help,
  children,
}: {
  help: string
  children: React.ReactNode
}) => {
  const id = useId()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  // Left-anchored by default; flipped to right-anchored when a left-anchored
  // panel would run past the viewport. These tooltips sit in a right-aligned
  // status column, where left-anchoring pushed most of the text off-screen.
  const [alignRight, setAlignRight] = useState(false)

  // Measure rather than assume: the trigger's position depends on the row it
  // lands in and on the window width, neither of which is knowable statically.
  const place = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    const { left } = el.getBoundingClientRect()
    setAlignRight(left + MAX_WIDTH + VIEWPORT_MARGIN > window.innerWidth)
  }, [])

  // Before paint, so the panel never appears in the wrong place first.
  useLayoutEffect(() => {
    if (!open) return
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, place])

  return (
    <span
      ref={wrapRef}
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <button
        type='button'
        aria-describedby={id}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
        style={{
          font: 'inherit',
          color: 'inherit',
          background: 'none',
          border: 'none',
          padding: 0,
          margin: 0,
          cursor: 'help',
          borderBottom: '1px dotted #999',
        }}
      >
        {children}
        <span style={{ color: '#595959', marginLeft: 3, fontSize: '0.8em' }}>
          ?
        </span>
      </button>
      <span
        role='tooltip'
        id={id}
        style={{
          position: 'absolute',
          ...(alignRight ? { right: 0 } : { left: 0 }),
          top: '100%',
          marginTop: 4,
          zIndex: 10,
          display: open ? 'block' : 'none',
          background: '#1a202c',
          color: '#fff',
          padding: '6px 10px',
          borderRadius: 4,
          fontSize: 13,
          fontWeight: 400,
          lineHeight: 1.4,
          width: 'max-content',
          // Never wider than the viewport allows, so a narrow window clamps
          // instead of overflowing.
          maxWidth: `min(${MAX_WIDTH}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))`,
          whiteSpace: 'normal',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        }}
      >
        {help}
      </span>
    </span>
  )
}

export default Tooltip
