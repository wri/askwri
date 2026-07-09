'use client'

import { useEffect, useRef } from 'react'

const AUTO_DISMISS_MS = 6000

/**
 * Flash — shared feedback notice for the admin UI. Fixed bottom-right, above
 * the sticky ReviewBar (zIndex 10). role='status' + aria-live='polite'
 * announces changes to screen readers. Success notices auto-dismiss after 6 s;
 * errors persist until dismissed or replaced. Latest message wins — no queue.
 * Pages keep their own notice/error state; only rendering moves here.
 */
export const Flash = ({
  notice,
  error,
  onDismiss,
}: {
  notice: string | null
  error: string | null
  onDismiss: () => void
}) => {
  // Keep the latest onDismiss without re-arming the timer on every parent render.
  const dismissRef = useRef(onDismiss)
  useEffect(() => {
    dismissRef.current = onDismiss
  })

  useEffect(() => {
    // Only a standalone notice auto-dismisses; an error (which wins the display)
    // must persist.
    if (!notice || error) return
    const t = setTimeout(() => dismissRef.current(), AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [notice, error])

  if (!notice && !error) return null

  const isError = error != null
  const message = error ?? notice
  const fg = isError ? '#C11101' : '#0A6640'
  const bg = isError ? '#FDEDEC' : '#E6F4EA'

  return (
    <div
      role='status'
      aria-live='polite'
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        zIndex: 1000,
        maxWidth: 360,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '10px 14px',
        borderRadius: 6,
        background: bg,
        border: `1px solid ${fg}`,
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      }}
    >
      <span style={{ color: fg, flex: 1 }}>{message}</span>
      <button
        type='button'
        onClick={onDismiss}
        aria-label='Dismiss'
        style={{
          color: fg,
          cursor: 'pointer',
          background: 'none',
          border: 'none',
          fontSize: 18,
          lineHeight: 1,
          padding: 0,
        }}
      >
        ×
      </button>
    </div>
  )
}

export default Flash
