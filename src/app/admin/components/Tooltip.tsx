'use client'

import { useId, useState } from 'react'

/**
 * Tooltip / HelpHint — an inline help marker with a keyboard-, touch-, and
 * screen-reader-reachable tooltip.
 *
 * Same API as before: <Tooltip help='…'>label</Tooltip>. The trigger is a real
 * <button> (natively focusable — no tabIndex, no role) wrapping ONLY the label
 * text + a "?" marker. The help text is a role='tooltip' popover, shown on
 * hover, focus, and tap (click toggles for touch), dismissed on blur/Escape.
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

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type='button'
        aria-describedby={id}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
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
          left: 0,
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
          maxWidth: 280,
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
