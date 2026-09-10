'use client'

import type { PersonResult, RankMode } from '@/lib/experts/types'
import { ACCENT, ACCENT_WASH, officeColor } from './officeColor'
import './Experts.css'

export function yearsLabel(years: [number, number] | null): string {
  if (!years) return ''
  return years[0] === years[1] ? String(years[0]) : `${years[0]}–${years[1]}`
}

export function evidenceLine(p: PersonResult, mode: RankMode): string {
  const yr = yearsLabel(p.evidence.years)
  if (mode === 'topic_only') {
    const n = p.docIds.length
    return `${n} doc${n === 1 ? '' : 's'} on these topics${yr ? ' · ' + yr : ''}`
  }
  const parts: string[] = []
  if (p.evidence.strong) parts.push(`${p.evidence.strong} strong`)
  if (p.evidence.partial) parts.push(`${p.evidence.partial} partial`)
  if (p.evidence.weak) parts.push(`${p.evidence.weak} weak`)
  const tierPart = parts.length > 0 ? ` · ${parts.join(' · ')}` : ''
  return `${p.evidence.docs} doc${p.evidence.docs === 1 ? '' : 's'}${tierPart}${yr ? ' · ' + yr : ''}`
}

export const ExpertsList = ({
  people,
  mode,
  selectedKey,
  peerKeys,
  onHover,
  onSelect,
}: {
  people: PersonResult[]
  mode: RankMode
  selectedKey: string | null
  peerKeys: Set<string>
  onHover: (key: string | null) => void
  onSelect: (key: string) => void
}) => (
  <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
    {people.map((p, i) => (
      <li key={p.key}>
        <button
          type='button'
          className='experts-row'
          id={`expert-row-${encodeURIComponent(p.key)}`}
          aria-pressed={selectedKey === p.key}
          data-peer={peerKeys.has(p.key) ? 'true' : 'false'}
          onMouseEnter={() => onHover(p.key)}
          onMouseLeave={() => onHover(null)}
          onFocus={() => onHover(p.key)}
          onBlur={() => onHover(null)}
          onClick={() => onSelect(p.key)}
          style={{
            width: '100%',
            textAlign: 'left',
            background: 'none',
            border: 0,
            borderBottom: '1px solid #E6E2D6',
            display: 'grid',
            gridTemplateColumns: '28px 1fr',
            columnGap: 10,
            padding: '12px 6px 12px 4px',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          <span
            style={{
              fontVariantNumeric: 'tabular-nums',
              color: '#8A877E',
              fontSize: 12,
              paddingTop: 3,
            }}
          >
            {i + 1}
          </span>
          <span>
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontWeight: 600, fontSize: 14.5 }}>{p.name}</span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 12,
                  color: '#5E5B52',
                }}
              >
                <i
                  aria-hidden='true'
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: officeColor(p.office),
                    display: 'inline-block',
                  }}
                />
                {p.office}
              </span>
              {p.unverified && (
                <span style={{ fontSize: 11, color: '#8A877E' }}>
                  name as stored
                </span>
              )}
            </span>
            <span
              aria-hidden='true'
              style={{
                display: 'block',
                height: 3,
                background: '#E6E2D6',
                borderRadius: 2,
                margin: '7px 0 6px',
                overflow: 'hidden',
              }}
            >
              <i
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${Math.round(p.score * 100)}%`,
                  background: ACCENT,
                }}
              />
            </span>
            <span
              style={{
                display: 'block',
                fontSize: 12.5,
                color: '#5E5B52',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {evidenceLine(p, mode)}
            </span>
            <span
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 4,
                marginTop: 6,
              }}
            >
              {p.topics
                .filter((t) => t.matched)
                .slice(0, 3)
                .map((t) => (
                  <span
                    key={t.label}
                    style={{
                      fontSize: 11.5,
                      padding: '1px 7px',
                      borderRadius: 3,
                      background: ACCENT_WASH,
                      color: '#7A5400',
                    }}
                  >
                    {t.label} <span style={{ opacity: 0.7 }}>{t.n}</span>
                  </span>
                ))}
            </span>
          </span>
        </button>
      </li>
    ))}
  </ol>
)
