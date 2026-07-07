'use client'

/**
 * Tooltip / HelpHint — a small inline help marker with a hover tooltip.
 *
 * Uses the native `title` attribute (screen-reader accessible without JS) plus
 * a styled "?" marker so the tooltip is discoverable. No Chakra provider
 * dependency — works in any context.
 *
 * Usage:
 *   <Tooltip help="The authors as listed in the source CSV.">Authors</Tooltip>
 */
export function Tooltip({
  help,
  children,
}: {
  help: string
  children: React.ReactNode
}) {
  return (
    <span
      title={help}
      style={{ cursor: 'help', borderBottom: '1px dotted #999' }}
    >
      {children}
      <span style={{ color: '#888', marginLeft: 3, fontSize: '0.8em' }}>?</span>
    </span>
  )
}

export default Tooltip
