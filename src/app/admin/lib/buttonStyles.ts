import type { CSSProperties } from 'react'

/**
 * Shared inline-style constants giving admin action controls a real button
 * treatment (border, padding, radius) instead of bare underlined text.
 *
 * - `actionButton` — ordinary actions (Save, Promote, Add, pagination, …).
 * - `dangerButton` — destructive actions (Delete).
 *
 * Apply alongside className='admin-btn' so :hover / :focus-visible (which
 * cannot be inlined) come from the single rule in src/app/globals.css.
 * Controls that GO somewhere (navigation) stay styled <Link>/<a>, not buttons.
 */
export const actionButton: CSSProperties = {
  font: 'inherit',
  background: '#fff',
  color: '#1a365d',
  border: '1px solid #cbd5e0',
  borderRadius: 4,
  padding: '4px 10px',
  cursor: 'pointer',
  lineHeight: 1.4,
}

export const dangerButton: CSSProperties = {
  ...actionButton,
  color: '#C11101',
  borderColor: '#f0b4b4',
}
