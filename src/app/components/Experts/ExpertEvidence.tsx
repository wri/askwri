'use client'

import { Button } from '@worldresources/wri-design-systems'
import type { Peer } from '@/lib/experts/peers'
import type {
  DocResult,
  MatchedTag,
  PersonResult,
  RankMode,
} from '@/lib/experts/types'
import { ACCENT_WASH } from './officeColor'
import { yearsLabel } from './ExpertsList'
import './Experts.css'

const TIER_ORDER = { strong: 3, partial: 2, weak: 1 } as const

export const ExpertEvidence = ({
  person,
  docs,
  peers,
  mode,
  matched,
  onSelectPeer,
  onClose,
}: {
  person: PersonResult
  docs: Record<string, DocResult>
  peers: Peer[]
  mode: RankMode
  matched: MatchedTag[]
  onSelectPeer: (key: string) => void
  onClose: () => void
}) => {
  const matchedSet = new Set(matched.map((t) => t.label))
  const offices = Object.entries(person.offices)
    .sort((a, b) => b[1] - a[1])
    .map(([o, n]) => `${o} (${n})`)
    .join(', ')
  const list = person.docIds
    .map((id) => docs[id])
    .filter(Boolean)
    .sort(
      (a, b) =>
        (TIER_ORDER[b.tier ?? 'weak'] ?? 0) -
          (TIER_ORDER[a.tier ?? 'weak'] ?? 0) || (b.year ?? 0) - (a.year ?? 0),
    )
  const matchLine =
    mode === 'evidence'
      ? `${person.evidence.docs} of ${person.evidence.corpusDocs} documents match`
      : `${person.docIds.length} of ${person.evidence.corpusDocs} documents are on these topics`
  return (
    <aside
      aria-live='polite'
      style={{
        marginTop: 16,
        background: 'white',
        border: '1px solid #E6E2D6',
        borderRadius: 6,
        padding: '16px 18px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            {person.name}
          </h3>
          <div style={{ color: '#5E5B52', fontSize: 13, marginTop: 2 }}>
            {offices} · {matchLine} · {yearsLabel(person.evidence.years)}
          </div>
        </div>
        <Button variant='borderless' size='small' onClick={onClose}>
          Close
        </Button>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 18,
          marginTop: 14,
        }}
      >
        <div>
          <h4
            style={{
              margin: '0 0 8px',
              fontSize: 11.5,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: '#8A877E',
              fontWeight: 600,
            }}
          >
            {mode === 'evidence'
              ? `Evidence · ${person.evidence.strong} strong, ${person.evidence.partial} partial, ${person.evidence.weak} weak`
              : 'Documents on these topics'}
          </h4>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {list.map((d) => {
              const pos = d.authors.findIndex((a) => a.key === person.key) + 1
              return (
                <li
                  key={d.docId}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '64px 1fr',
                    gap: 10,
                    padding: '7px 0',
                    borderTop: '1px solid #E6E2D6',
                  }}
                >
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      padding: '2px 6px',
                      borderRadius: 3,
                      textAlign: 'center',
                      background:
                        d.tier === 'strong'
                          ? ACCENT_WASH
                          : d.tier === 'partial'
                            ? 'rgba(240,171,0,0.16)'
                            : '#E6E2D6',
                      color: d.tier ? '#7A5400' : '#5E5B52',
                    }}
                  >
                    {d.tier ?? 'topic'}
                  </span>
                  <span>
                    <div
                      data-testid='evidence-doc-title'
                      style={{ fontSize: 13, lineHeight: 1.35 }}
                    >
                      {d.url ? (
                        <a
                          href={d.url}
                          target='_blank'
                          rel='noopener noreferrer'
                        >
                          {d.title}
                        </a>
                      ) : (
                        d.title
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: '#8A877E',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {[d.year, d.type, d.office].filter(Boolean).join(' · ')} ·
                      author {pos} of {d.authors.length}
                      {d.translations.length > 0 &&
                        ` · also in ${d.translations.length} translation${d.translations.length === 1 ? '' : 's'}`}
                    </div>
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
        <div>
          <h4
            style={{
              margin: '0 0 8px',
              fontSize: 11.5,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: '#8A877E',
              fontWeight: 600,
            }}
          >
            Works alongside
          </h4>
          {peers.length === 0 && (
            <div style={{ fontSize: 13, color: '#8A877E' }}>
              No one else in this list shares their specific topics.
            </div>
          )}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {peers.slice(0, 6).map((q) => (
              <li
                key={q.key}
                style={{
                  padding: '6px 0',
                  borderTop: '1px solid #E6E2D6',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  fontSize: 13,
                }}
              >
                <button
                  type='button'
                  className='experts-peer-btn'
                  onClick={() => onSelectPeer(q.key)}
                >
                  {q.name}
                </button>
                <span
                  style={{
                    color: '#8A877E',
                    fontSize: 12,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {q.topics.slice(0, 2).join(', ')}
                  {q.topics.length > 2 ? ` +${q.topics.length - 2}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <h4
            style={{
              margin: '16px 0 8px',
              fontSize: 11.5,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: '#8A877E',
              fontWeight: 600,
            }}
          >
            All topics on their documents
          </h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {person.topics.slice(0, 14).map((t) => (
              <span
                key={t.label}
                style={{
                  fontSize: 11.5,
                  padding: '1px 7px',
                  borderRadius: 3,
                  background: matchedSet.has(t.label) ? ACCENT_WASH : '#E6E2D6',
                  color: matchedSet.has(t.label) ? '#7A5400' : '#5E5B52',
                }}
              >
                {t.label} {t.n}
              </span>
            ))}
          </div>
        </div>
      </div>
    </aside>
  )
}
