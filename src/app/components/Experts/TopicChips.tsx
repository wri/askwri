'use client'

import type { MatchedTag } from '@/lib/experts/types'
import { ACCENT } from './officeColor'
import './Experts.css'

// Sibling of InterpretationLine (spec §7): same idiom, plus a strength slot.
export const TopicChips = ({
  topics,
  geographies,
  derived = false,
  onHoverTopic,
  onRemove,
}: {
  topics: MatchedTag[]
  geographies: MatchedTag[]
  /** U3: the topic facet degraded, so `cosine` on a TOPIC is a normalized count
   *  over the retrieved documents' own tags, not a query→tag cosine. Showing it
   *  as "1.00" is indistinguishable from a perfect match, so it is suppressed.
   *  Geography cosines are unaffected. */
  derived?: boolean
  /** U14: topic hover was mouse-only inside the graph. The chips are the
   *  keyboard-reachable twin, so they emit it on hover AND on focus of their
   *  one tab stop (the remove control) — no extra tab stops added. */
  onHoverTopic?: (label: string | null) => void
  onRemove: (label: string) => void
}) => {
  if (topics.length === 0 && geographies.length === 0) return null
  const chip = (t: MatchedTag, removable: boolean, hideStrength = false) => (
    <span
      key={`${removable ? 't' : 'g'}:${t.label}`}
      onMouseEnter={
        removable && onHoverTopic ? () => onHoverTopic(t.label) : undefined
      }
      onMouseLeave={
        removable && onHoverTopic ? () => onHoverTopic(null) : undefined
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        borderRadius: 999,
        padding: '3px 8px 3px 10px',
        fontSize: 12.5,
        border: `1px solid ${removable ? ACCENT : '#D6D1C2'}`,
        background: removable ? 'rgba(240,171,0,0.16)' : 'white',
      }}
    >
      {t.label}
      {!hideStrength && (
        <span
          style={{
            fontSize: 11,
            color: '#8A877E',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {t.cosine.toFixed(2)}
        </span>
      )}
      {removable && (
        <button
          type='button'
          className='experts-chip-x'
          aria-label={`Remove ${t.label}`}
          onFocus={onHoverTopic ? () => onHoverTopic(t.label) : undefined}
          onBlur={onHoverTopic ? () => onHoverTopic(null) : undefined}
          onClick={() => onRemove(t.label)}
        >
          ✕
        </button>
      )}
    </span>
  )
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        marginTop: 12,
        fontSize: 13,
        color: '#5E5B52',
      }}
    >
      <span>Reading your query as</span>
      {topics.map((t) => chip(t, true, derived))}
      {geographies.map((g) => chip(g, false))}
    </div>
  )
}
