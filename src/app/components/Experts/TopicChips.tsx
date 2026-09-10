'use client'

import type { MatchedTag } from '@/lib/experts/types'
import { ACCENT } from './officeColor'
import './Experts.css'

// Sibling of InterpretationLine (spec §7): same idiom, plus a strength slot.
export const TopicChips = ({
  topics,
  geographies,
  onRemove,
}: {
  topics: MatchedTag[]
  geographies: MatchedTag[]
  onRemove: (label: string) => void
}) => {
  if (topics.length === 0 && geographies.length === 0) return null
  const chip = (t: MatchedTag, removable: boolean) => (
    <span
      key={`${removable ? 't' : 'g'}:${t.label}`}
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
      <span
        style={{
          fontSize: 11,
          color: '#8A877E',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {t.cosine.toFixed(2)}
      </span>
      {removable && (
        <button
          type='button'
          className='experts-chip-x'
          aria-label={`Remove ${t.label}`}
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
      {topics.map((t) => chip(t, true))}
      {geographies.map((g) => chip(g, false))}
    </div>
  )
}
