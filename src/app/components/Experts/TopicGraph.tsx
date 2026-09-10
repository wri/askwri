'use client'

import { useMemo, useState } from 'react'
import { computeLayout } from '@/lib/experts/layout'
import type { MatchedTag, PersonResult } from '@/lib/experts/types'
import { ACCENT, ACCENT_WASH, INK, officeColor } from './officeColor'

const W = 940
const H = 760
const LABEL_AT_REST = 8
const REST_HINT =
  'Hover a person to see their topics and who else works in them. Click to pin and open the evidence. Names for people ranked 9–20 appear on hover.'

function shortName(n: string): string {
  const [fam, giv] = n.split(', ')
  return giv ? `${giv.split(' ')[0]} ${fam}` : fam
}

type NodeState = 'rest' | 'focus' | 'peer' | 'dim' | 'on'

export const TopicGraph = ({
  people,
  matched,
  hoverKey,
  selectedKey,
  peerKeys,
  onHover,
  onSelect,
}: {
  people: PersonResult[]
  matched: MatchedTag[]
  totalWorks: number // accepted for future peer wiring; not destructured yet
  hoverKey: string | null
  selectedKey: string | null
  peerKeys: Set<string>
  onHover: (key: string | null) => void
  onSelect: (key: string) => void
}) => {
  const [hoverTopic, setHoverTopic] = useState<string | null>(null)
  const layout = useMemo(
    () => computeLayout(people, matched, W, H, 7),
    [people, matched],
  )
  const byId = useMemo(
    () => new Map(layout.nodes.map((n) => [n.id, n])),
    [layout],
  )
  const personByKey = useMemo(
    () => new Map(people.map((p) => [p.key, p])),
    [people],
  )

  const active = selectedKey ?? hoverKey
  const activeTopics = new Set(
    active
      ? (personByKey
          .get(active)
          ?.topics.filter((t) => t.matched)
          .map((t) => t.label) ?? [])
      : [],
  )
  const withTopic = new Set(
    hoverTopic && !active
      ? people
          .filter((p) =>
            p.topics.some((t) => t.label === hoverTopic && t.n > 0),
          )
          .map((p) => p.key)
      : [],
  )

  const personState = (key: string): NodeState => {
    if (active)
      return key === active ? 'focus' : peerKeys.has(key) ? 'peer' : 'dim'
    if (hoverTopic) return withTopic.has(key) ? 'peer' : 'dim'
    return 'rest'
  }
  const topicState = (label: string): NodeState => {
    if (active) return activeTopics.has(label) ? 'on' : 'dim'
    if (hoverTopic) return label === hoverTopic ? 'on' : 'dim'
    return 'rest'
  }
  const edgeState = (source: string, target: string): NodeState => {
    const pk = source.slice(2)
    const tl = target.slice(2)
    if (active) {
      if (pk === active) return 'on'
      if (peerKeys.has(pk) && activeTopics.has(tl)) return 'peer'
      return 'dim'
    }
    if (hoverTopic) return tl === hoverTopic ? 'on' : 'dim'
    return 'rest'
  }

  let hint = REST_HINT
  if (active && personByKey.get(active)) {
    const p = personByKey.get(active)!
    const n = p.topics.filter((t) => t.matched).length
    hint = `${shortName(p.name)} · ${n} matched topic${n === 1 ? '' : 's'} · shares topics with ${peerKeys.size} other ranked ${peerKeys.size === 1 ? 'person' : 'people'} (highlighted)`
  } else if (hoverTopic) {
    hint = `${hoverTopic} · ${withTopic.size} of the ${people.length} shown people have documents tagged with it`
  }

  const opacityFor = (s: NodeState) => (s === 'dim' ? 0.16 : 1)
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role='img'
        aria-label={`${people.length} people connected to the ${matched.length} topics that match the query`}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      >
        <g>
          {layout.links.map((l) => {
            const s = byId.get(l.source)!
            const t = byId.get(l.target)!
            const st = edgeState(l.source, l.target)
            return (
              <line
                key={`${l.source}-${l.target}`}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                stroke={st === 'on' || st === 'peer' ? ACCENT : '#C9C4B4'}
                strokeOpacity={st === 'dim' ? 0.12 : st === 'peer' ? 0.35 : 1}
                strokeWidth={0.8 + 0.7 * Math.min(l.w, 5)}
              />
            )
          })}
        </g>
        <g>
          {layout.nodes
            .filter((n) => n.kind === 'topic')
            .map((n) => {
              const st = topicState(n.key)
              return (
                <g
                  key={n.id}
                  data-testid='topic-node'
                  transform={`translate(${n.x},${n.y})`}
                  opacity={opacityFor(st)}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoverTopic(n.key)}
                  onMouseLeave={() => setHoverTopic(null)}
                >
                  <circle r={Math.max(n.r + 8, 16)} fill='transparent' />
                  <circle
                    r={n.r}
                    fill={st === 'on' ? ACCENT_WASH : 'white'}
                    stroke={ACCENT}
                    strokeWidth={2}
                  />
                  <text
                    textAnchor='middle'
                    y={n.r + 13}
                    fontSize={11}
                    fontWeight={600}
                    fill={st === 'on' ? '#7A5400' : '#5E5B52'}
                    style={{ pointerEvents: 'none' }}
                  >
                    {n.key}
                  </text>
                </g>
              )
            })}
          {layout.nodes
            .filter((n) => n.kind === 'person')
            .map((n) => {
              const p = personByKey.get(n.key)!
              const rankIndex = people.indexOf(p)
              const st = personState(n.key)
              const quiet =
                rankIndex >= LABEL_AT_REST &&
                st !== 'focus' &&
                st !== 'peer' &&
                hoverKey !== n.key
              const label = shortName(p.name)
              const pillW = label.length * 6.6 + 10
              return (
                <g
                  key={n.id}
                  data-testid='person-node'
                  data-state={st}
                  transform={`translate(${n.x},${n.y})`}
                  opacity={opacityFor(st)}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => onHover(n.key)}
                  onMouseLeave={() => onHover(null)}
                  onClick={() => onSelect(n.key)}
                >
                  <circle r={Math.max(n.r + 8, 16)} fill='transparent' />
                  {st === 'focus' && selectedKey === n.key && (
                    <circle
                      r={n.r + 6}
                      fill='none'
                      stroke={INK}
                      strokeWidth={2.5}
                    />
                  )}
                  <circle
                    r={n.r}
                    fill={officeColor(p.office)}
                    stroke={st === 'peer' ? ACCENT : 'white'}
                    strokeWidth={st === 'peer' ? 1.5 : 2}
                  />
                  {st === 'focus' && selectedKey === n.key && (
                    <rect
                      x={n.r + 4}
                      y={-9}
                      width={pillW}
                      height={18}
                      rx={3}
                      fill={INK}
                    />
                  )}
                  <text
                    data-testid='person-label'
                    data-quiet={quiet ? 'true' : 'false'}
                    x={n.r + 9}
                    y={4}
                    fontSize={11.5}
                    fontWeight={st === 'focus' ? 700 : 500}
                    fill={
                      st === 'focus' && selectedKey === n.key ? '#FBFAF6' : INK
                    }
                    opacity={quiet ? 0 : 1}
                    style={{ pointerEvents: 'none' }}
                  >
                    {label}
                  </text>
                </g>
              )
            })}
        </g>
      </svg>
      <div
        data-testid='graph-hint'
        style={{
          padding: '8px 14px 10px',
          fontSize: 12,
          color: '#8A877E',
          borderTop: '1px solid #E6E2D6',
        }}
      >
        {hint}
      </div>
    </div>
  )
}
