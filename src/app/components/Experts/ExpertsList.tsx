'use client'

import type { PersonResult, RankMode } from '@/lib/experts/types'
import { ACCENT, ACCENT_WASH, officeColor } from './officeColor'
import './Experts.css'

export function yearsLabel(years: [number, number] | null): string {
  if (!years) return ''
  return years[0] === years[1] ? String(years[0]) : `${years[0]}–${years[1]}`
}

/** Did this person reach the list through retrieval, or only through topic
 *  space? `evidence.docs` counts RETRIEVED works only (spec §4.3 + rank.ts), so
 *  a tag-only candidate reports 0 there in EITHER mode while `docIds` still
 *  holds their topic-matched works. Every surface that phrases a person's
 *  evidence must branch on this rather than on the response `mode`, or the row
 *  and the panel it opens end up telling the reader different stories. */
export function hasTierEvidence(p: PersonResult): boolean {
  return p.evidence.strong > 0 || p.evidence.partial > 0 || p.evidence.weak > 0
}

export function evidenceLine(p: PersonResult, mode: RankMode): string {
  const yr = yearsLabel(p.evidence.years)
  if (mode === 'topic_only' || !hasTierEvidence(p)) {
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
  hoverTopic = null,
  onHover,
  onSelect,
}: {
  people: PersonResult[]
  mode: RankMode
  selectedKey: string | null
  peerKeys: Set<string>
  /** U14: the list is the graph's table twin (spec §8), so a topic hovered or
   *  focused on the chips marks the people who carry it here too. */
  hoverTopic?: string | null
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
          // U13: tie the row to the evidence panel it opens, so a screen
          // reader can follow the relationship instead of guessing.
          aria-expanded={selectedKey === p.key}
          aria-controls={
            selectedKey === p.key ? 'experts-evidence-panel' : undefined
          }
          data-peer={peerKeys.has(p.key) ? 'true' : 'false'}
          // Present ONLY while a topic is hovered. Emitting 'false' at rest made
          // the CSS's fade rule match every row at once, leaving the whole
          // ranked list — the page's primary surface — at 45% opacity.
          data-topic-match={
            hoverTopic
              ? p.topics.some((t) => t.label === hoverTopic)
                ? 'true'
                : 'false'
              : undefined
          }
          onMouseEnter={() => onHover(p.key)}
          onMouseLeave={() => onHover(null)}
          onFocus={() => onHover(p.key)}
          onBlur={() => onHover(null)}
          onClick={() => onSelect(p.key)}
          // background / border live in Experts.css, NOT here: an inline
          // declaration outranks any stylesheet rule, so setting them here
          // silently killed the hover wash, the selected row's ink left rule
          // (spec §8) and the gold peer tint. They looked correct in the CSS
          // file — and a test that reads that file as text cannot tell.
          style={{
            width: '100%',
            textAlign: 'left',
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
