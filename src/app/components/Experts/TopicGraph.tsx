'use client'

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { computeLayout } from '@/lib/experts/layout'
import type { MatchedTag, PersonResult } from '@/lib/experts/types'
import { ACCENT, ACCENT_WASH, INK, officeColor } from './officeColor'

const W = 940
const H = 760
const LABEL_AT_REST = 8
const DESC_ID = 'topic-graph-desc'
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
  topicsAreDerived = false,
  hoverKey,
  selectedKey,
  peerKeys,
  onHover,
  onSelect,
  hoverTopic: hoverTopicProp,
  onHoverTopic,
}: {
  people: PersonResult[]
  matched: MatchedTag[]
  /** True when /tags/nearby's topic facet was degraded and the rings are the
   *  retrieved documents' own accepted tags (spec §9, first row). Their size is
   *  then NOT a query cosine, so the accessible name must not say it is. */
  topicsAreDerived?: boolean
  hoverKey: string | null
  selectedKey: string | null
  peerKeys: Set<string>
  onHover: (key: string | null) => void
  onSelect: (key: string) => void
  /** Topic hover, lifted. Spec §8 makes the list the graph's table twin and
   *  requires every interaction to be reachable from the keyboard; the topic
   *  chips are the keyboard route in, and they live outside this component.
   *  Omit both props and the graph keeps its own state (mouse-only). */
  hoverTopic?: string | null
  onHoverTopic?: (label: string | null) => void
}) => {
  const [ownHoverTopic, setOwnHoverTopic] = useState<string | null>(null)
  const controlled = hoverTopicProp !== undefined
  const hoverTopic = controlled ? hoverTopicProp : ownHoverTopic
  const setHoverTopic = (label: string | null) => {
    onHoverTopic?.(label)
    if (!controlled) setOwnHoverTopic(label)
  }
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

  // The tab used to be sized `label.length * 6.6 + 10`, which under-measured
  // proportional text: "Lulu Xue" ran 5px past its own ink and the final glyph
  // vanished into the white background. Measure the rendered glyphs instead —
  // only one person is ever pinned, so this is a single measurement.
  const tabTextRef = useRef<SVGTextElement | null>(null)
  const [tabWidth, setTabWidth] = useState(0)
  useLayoutEffect(() => {
    const el = tabTextRef.current
    if (!el) {
      setTabWidth(0)
      return
    }
    // jsdom implements no text metrics, so keep the old character estimate as a
    // FALLBACK: the component must still render a tab under test, it just
    // cannot be measured there. Browsers take the measured path.
    const measured =
      typeof el.getComputedTextLength === 'function'
        ? el.getComputedTextLength()
        : 0
    const estimated = (el.textContent || '').length * 6.6
    setTabWidth(Math.max(measured, estimated) + 12)
  }, [selectedKey, hoverKey, people, matched])

  const opacityFor = (s: NodeState) => (s === 'dim' ? 0.16 : 1)
  const topicPhrase = topicsAreDerived
    ? `${matched.length} topics drawn from the retrieved documents' own tags`
    : `${matched.length} topics that match the query`
  const ringPhrase = topicsAreDerived
    ? "each gold ring is a topic taken from the retrieved documents' own accepted tags, sized by how prominent that tag is across them — these are not query match strengths"
    : 'each gold ring is a topic that matches the query, sized by how strongly it matches'
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role='img'
        aria-label={`${people.length} people connected to the ${topicPhrase}`}
        aria-describedby={DESC_ID}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      >
        <desc id={DESC_ID}>
          {`Each filled circle is a person, sized by rank score and colored by office; ${ringPhrase}. A line joins a person to a topic their documents are tagged with. The ranked list below carries the same information and every interaction.`}
        </desc>
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
          {/* Interaction + marks. Labels are a SEPARATE pass below: SVG paints
              in document order, so a node drawn after a label overdraws it —
              "Ryan Sclar" lost its last letter under a neighbouring circle. */}
          {layout.nodes
            .filter((n) => n.kind === 'person')
            .map((n) => {
              const p = personByKey.get(n.key)!
              const st = personState(n.key)
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
                  {/* Spec §8: hover is halo-only, so the halo follows focus
                      (hovered OR pinned) and only the name tab is pinned-only. */}
                  {st === 'focus' && (
                    <circle
                      data-testid='person-halo'
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
              const pinned = st === 'focus' && selectedKey === n.key
              return (
                <g
                  key={`label:${n.id}`}
                  transform={`translate(${n.x},${n.y})`}
                  opacity={opacityFor(st)}
                  style={{ pointerEvents: 'none' }}
                >
                  {pinned && tabWidth > 0 && (
                    <rect
                      data-testid='person-name-tab'
                      x={n.r + 4}
                      y={-9}
                      width={tabWidth}
                      height={18}
                      rx={3}
                      fill={INK}
                    />
                  )}
                  <text
                    ref={pinned ? tabTextRef : undefined}
                    data-testid='person-label'
                    data-quiet={quiet ? 'true' : 'false'}
                    x={n.r + 9}
                    y={4}
                    fontSize={11.5}
                    fontWeight={st === 'focus' ? 700 : 500}
                    fill={pinned ? '#FBFAF6' : INK}
                    opacity={quiet ? 0 : 1}
                  >
                    {shortName(p.name)}
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
