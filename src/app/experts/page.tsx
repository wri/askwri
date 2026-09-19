'use client'

import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Spinner } from '@chakra-ui/react'
import {
  AlertBanner,
  Button,
  InlineMessage,
  Tag,
  Textarea,
} from '@worldresources/wri-design-systems'
import { FaArrowRightLong } from 'react-icons/fa6'
import Navbar from '@/app/components/results/Navbar'
import { EmptyStateTopics } from '@/app/components/results/EmptyStateTopics'
import QuerySuggestions from '@/app/components/QuerySuggestions'
import { ExpertsList } from '@/app/components/Experts/ExpertsList'
import { ExpertEvidence } from '@/app/components/Experts/ExpertEvidence'
import { OrganizationsStrip } from '@/app/components/Experts/OrganizationsStrip'
import { TopicChips } from '@/app/components/Experts/TopicChips'
import { TopicGraph } from '@/app/components/Experts/TopicGraph'
import {
  OFFICE_COLORS,
  OTHER_OFFICE_COLOR,
} from '@/app/components/Experts/officeColor'
import { fetchExperts } from '@/lib/experts-client'
import {
  isTopicDegraded,
  isTopicDerived,
  QUERY_DEGRADED,
  TOPIC_NO_MATCH,
} from '@/lib/experts/degraded'
import { peersOf } from '@/lib/experts/peers'
import type { ExpertsResponse } from '@/lib/experts/types'
import '../styles.css'

// encodeURIComponent, not URLSearchParams: the latter writes '+' for spaces,
// and the tests (and shared links) expect %20.
// U6: one `exclude` parameter PER topic. A single comma-joined value silently
// split labels that contain a comma ("Transport, Urban") into two exclusions
// that match nothing.
function buildUrl(q: string, person: string | null, exclude: string[]): string {
  const parts = [`q=${encodeURIComponent(q)}`]
  if (person) parts.push(`person=${encodeURIComponent(person)}`)
  for (const t of exclude) parts.push(`exclude=${encodeURIComponent(t)}`)
  return `/experts?${parts.join('&')}`
}

const ExpertsPageContent = () => {
  const router = useRouter()
  const searchParams = useSearchParams()
  const q = searchParams?.get('q')?.trim() ?? ''
  const personParam = searchParams?.get('person') ?? null
  // Depend on a STRING, not the searchParams object or a fresh array: a new
  // reference per render would re-fire the fetch effect forever. US (unit
  // separator) cannot occur in a decoded query-string value.
  const excludeKey = (searchParams?.getAll('exclude') ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\u001f')
  const excludeParam = useMemo(
    () => (excludeKey ? excludeKey.split('\u001f') : []),
    [excludeKey],
  )

  const [draft, setDraft] = useState(q)
  const [data, setData] = useState<ExpertsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const [hoverTopic, setHoverTopic] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(personParam)
  const loggedFor = useRef<string | null>(null)
  // U1: the route runs a retrieval + rerank + LLM sidecar, so a cache-warm
  // second query can beat the first one home. Every settle is checked against
  // the latest issued id; a superseded request writes nothing at all.
  const requestId = useRef(0)

  const run = useCallback(async (query: string, excluded: string[]) => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const res = await fetchExperts({ query, excluded_topics: excluded })
      if (id !== requestId.current) return
      setData(res)
    } catch (e: any) {
      if (id !== requestId.current) return
      setError(e?.message || 'Something went wrong')
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [])

  // U7: sync the textarea ONLY when the query itself changes. Folding this into
  // the fetch effect meant every exclude-list change wiped in-progress typing.
  useEffect(() => {
    if (!q) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- URL is the source of truth for the submitted query
    setDraft(q)
  }, [q])

  // U2: the URL is the single fetch trigger. Handlers only push; this effect
  // reacts. Calling run() in a handler AND pushing ran the whole pipeline twice.
  useEffect(() => {
    if (!q) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- URL is the source of truth; reset cached results when q is cleared
      setData(null)
      return
    }
    run(q, excludeParam)
  }, [q, excludeParam, run])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- person selection lives in the URL; adopt it on navigation
    setSelectedKey(personParam)
  }, [personParam])

  // Query log: once per (query, mode) after results render, fire-and-forget.
  useEffect(() => {
    if (!data || data.people.length === 0) return
    const stamp = `${data.query}|${data.mode}`
    if (loggedFor.current === stamp) return
    loggedFor.current = stamp
    fetch('/api/experts-mode-query-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: data.query,
        mode: data.mode,
        topTenPeople: JSON.stringify(
          data.people.slice(0, 10).map((p) => p.name),
        ),
      }),
    }).catch(() => {})
  }, [data])

  const submit = () => {
    const v = draft.trim()
    if (!v) return
    router.push(buildUrl(v, null, []))
  }
  const select = (key: string) => {
    const next = selectedKey === key ? null : key
    setSelectedKey(next)
    router.push(buildUrl(q, next, excludeParam))
    // jsdom has no scrollIntoView; optional-call keeps tests honest.
    if (next)
      document
        .getElementById(`expert-row-${encodeURIComponent(next)}`)
        ?.scrollIntoView?.({ block: 'nearest' })
  }
  // U2: push only. The exclude list lives in the URL, and the fetch effect
  // above re-runs off it — one retrieval per click, not two.
  const removeTopic = (label: string) => {
    router.push(buildUrl(q, null, [...excludeParam, label]))
  }

  const people = data?.people ?? []
  const matched = data?.understanding.matched_topics ?? []
  // A chip's remove control sets hoverTopic on focus and clears it on blur —
  // but clicking it unmounts the chip, and React fires no blur on unmount. The
  // hover would then point at a topic that has left the interpretation line,
  // fading every row that lacks it with nothing left on screen to retract it.
  // Depend on a joined STRING, not the array, so the effect does not re-fire
  // on every render. US (unit separator) cannot occur in a tag label.
  const matchedKey = matched.map((t) => t.label).join('\u001f')
  useEffect(() => {
    if (hoverTopic && !matchedKey.split('\u001f').includes(hoverTopic))
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the hovered topic is gone from the payload; no blur will ever arrive to clear it
      setHoverTopic(null)
  }, [matchedKey, hoverTopic])
  const totalWorks = useMemo(() => Object.keys(data?.docs ?? {}).length, [data])
  // Spec §4.5: peersOf's N is the count of searchable works (corpus N),
  // NOT the payload doc count (5-50). matched_topics[].df is corpus-wide,
  // so specificity = ln(N/df) needs the real corpus size or it goes negative
  // for hub topics and peers silently vanish. Fallback for older payloads.
  const corpusN = useMemo(
    () => data?.total_works ?? Math.max(totalWorks, 1),
    [data, totalWorks],
  )
  const activeKey = selectedKey ?? hoverKey
  const activePerson = activeKey
    ? (people.find((p) => p.key === activeKey) ?? null)
    : null
  const peers = useMemo(
    () => (activePerson ? peersOf(activePerson, people, matched, corpusN) : []),
    [activePerson, people, matched, corpusN],
  )
  const peerKeys = useMemo(() => new Set(peers.map((p) => p.key)), [peers])
  const selectedPerson = selectedKey
    ? (people.find((p) => p.key === selectedKey) ?? null)
    : null
  const offices = useMemo(() => new Set(people.map((p) => p.office)), [people])

  // U3: spec §9's degraded paths were computed and never shown. Say in plain
  // words what is unavailable and what the ranking fell back to.
  // U19: the page already guarded people/docs/matched_topics but not these,
  // and there is no error boundary — one missing array was a white screen.
  const nearbyTopics = useMemo(
    () =>
      (data?.understanding.suggestions ?? [])
        .filter((s) => s.type === 'nearby_topic')
        .map((s) => s.text),
    [data],
  )
  const organizations = data?.organizations ?? []
  const degraded = data?.understanding.degraded ?? []
  // I-1: two different facts, two different sentences. The search service
  // deliberately does NOT call "the facet answered, nothing cleared the cosine
  // floor" a degradation, so telling the reader a subsystem is unavailable
  // would be false. Both still mean the strengths on screen are doc-derived —
  // that is `topicsDegraded` (isTopicDerived), which drives the chips and graph.
  const topicsDegraded = isTopicDerived(degraded)
  const degradedNotes: string[] = []
  if (isTopicDegraded(degraded))
    degradedNotes.push(
      "Topic matching is unavailable. The topics below were taken from the matched documents' own tags, so they are not query match strengths, and people are ranked on document evidence alone.",
    )
  else if (degraded.includes(TOPIC_NO_MATCH))
    degradedNotes.push(
      "No topic in the library matched this question closely enough, so the topics below were taken from the matched documents' own tags. They are not query match strengths, and people are ranked on document evidence alone.",
    )
  if (degraded.includes(QUERY_DEGRADED))
    degradedNotes.push(
      'Document search is unavailable. Nobody could be ranked on documents that match your question, so this ranking is by topic alone.',
    )

  return (
    <>
      {/* React 19 hoists <meta> rendered anywhere into <head>. Unlisted page. */}
      <meta name='robots' content='noindex' />
      <Navbar query={q} newSearchHref='/experts' />
      <main style={{ paddingTop: 64 }}>
        <AlertBanner title='For WRI staff use only' variant='warning'>
          <div style={{ textAlign: 'left' }}>
            Experts mode is an internal prototype. It ranks people by their
            published WRI work only; it has no contact details and no review or
            correction history.{' '}
            <Link href='/experts/help' style={{ textDecoration: 'underline' }}>
              How this works
            </Link>
          </div>
        </AlertBanner>

        <section
          className='gradient-background'
          style={{
            padding: '22px 24px 18px',
            borderBottom: '1px solid #E6E2D6',
          }}
        >
          <div style={{ maxWidth: 1400, margin: '0 auto' }}>
            {/* div, not p: the design-system Tag renders a div, and a div
                inside a p is invalid nesting React warns about. */}
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: '#5E5B52',
                margin: '0 0 8px',
              }}
            >
              Who at WRI works on… <Tag label='Alpha' variant='info-grey' />
            </div>
            <div style={{ position: 'relative', maxWidth: 760 }}>
              <Textarea
                placeholder='Electric school buses'
                size='small'
                resize='none'
                value={draft}
                aria-label='Expertise query input'
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    submit()
                  }
                }}
              />
              <Button
                leftIcon={<FaArrowRightLong />}
                variant='primary'
                disabled={!draft.trim()}
                aria-label='Find people'
                type='button'
                onClick={submit}
                style={{ position: 'absolute', right: 12, bottom: 30 }}
              />
            </div>
            {!q && (
              <QuerySuggestions
                mode='experts'
                onExampleClick={(s) => router.push(buildUrl(s, null, []))}
              />
            )}
            {/* U9: the interpretation line is part of the result set, so it
                dims with the bench instead of sitting at full opacity above a
                greyed-out list while a new query loads. */}
            <div
              data-testid='experts-interpretation'
              style={{ opacity: loading && data ? 0.6 : 1 }}
            >
              {degradedNotes.length > 0 && (
                <div style={{ marginTop: 12, maxWidth: 760 }}>
                  <InlineMessage
                    variant='info-grey'
                    size='small-full-width'
                    label='Partial results'
                    caption={degradedNotes.join(' ')}
                  />
                </div>
              )}
              {data && (
                <TopicChips
                  topics={matched}
                  geographies={data.understanding.matched_geographies ?? []}
                  derived={topicsDegraded}
                  onHoverTopic={setHoverTopic}
                  onRemove={removeTopic}
                />
              )}
              {data && people.length > 0 && (
                // One text node: the test's getByText regex can only match a
                // single element's direct text, so no nested <b> around numbers.
                // U4: `total_people` is corpus-wide but `offices`/`totalWorks`
                // describe the shown top-N only, so the old single sentence was
                // false whenever the list was truncated. Each clause now names
                // the population it actually counts.
                <p style={{ marginTop: 10, fontSize: 13, color: '#5E5B52' }}>
                  {data.total_people > people.length
                    ? `${data.total_people} people match. Showing the top ${people.length} — across ${offices.size} offices, on ${totalWorks} documents.`
                    : `${people.length} people across ${offices.size} offices, on ${totalWorks} documents that match.`}
                </p>
              )}
            </div>
          </div>
        </section>

        {q && error && (
          // U8: design-system InlineMessage (spec §7 states table), not a
          // hand-rolled #a33 div. `error` holds raw upstream copy ("internal
          // error", "experts request failed (500)") which is never shown to a
          // reader; the query and the exclude chips are preserved above.
          <div
            style={{ maxWidth: 1400, margin: '18px auto', padding: '0 24px' }}
          >
            <InlineMessage
              variant='error'
              size='full-width'
              label='We could not load people for this question.'
              caption='The search service did not answer. Your question and topic filters are unchanged — try again.'
              actionLabel='Retry'
              isButtonRight
              onActionClick={() => run(q, excludeParam)}
            />
          </div>
        )}

        {q && loading && !data && !error && (
          // U9 / spec §7: with no previous results to hold at reduced opacity,
          // Loading is skeleton rows plus a graph card with a spinner — the
          // shape of the answer, not a bare centred spinner.
          <div
            className='experts-bench'
            aria-busy='true'
            style={{
              maxWidth: 1400,
              margin: '0 auto',
              padding: '18px 24px 48px',
              display: 'grid',
              gridTemplateColumns: 'minmax(380px, 460px) 1fr',
              gap: 20,
              alignItems: 'start',
            }}
          >
            <div data-testid='experts-skeleton'>
              {Array.from({ length: 6 }, (_, i) => (
                <div
                  key={i}
                  className='experts-skeleton-row'
                  style={{
                    borderBottom: '1px solid #E6E2D6',
                    padding: '12px 4px',
                  }}
                >
                  <span
                    className='experts-skeleton-bar'
                    style={{ display: 'block', height: 12, width: '46%' }}
                  />
                  <span
                    className='experts-skeleton-bar'
                    style={{
                      display: 'block',
                      height: 3,
                      margin: '10px 0 8px',
                    }}
                  />
                  <span
                    className='experts-skeleton-bar'
                    style={{ display: 'block', height: 10, width: '62%' }}
                  />
                </div>
              ))}
            </div>
            <div
              data-testid='experts-graph-skeleton'
              style={{
                background: 'white',
                border: '1px solid #E6E2D6',
                borderRadius: 6,
                minHeight: 360,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Spinner />
            </div>
          </div>
        )}

        {q && data && data.mode === 'topic_only' && people.length > 0 && (
          // U16: spec §7 sanctions "amber", which is the design system's
          // warning token — not the Bootstrap hexes this used to hard-code.
          // U21: `topic_only` has two triggers. Empty retrieval really is "no
          // direct matches"; `likely_off_topic` fires WITH results, so its copy
          // must claim less rather than more (spec §4.4).
          <div
            style={{ maxWidth: 1400, margin: '12px auto 0', padding: '0 24px' }}
          >
            <InlineMessage
              variant='warning'
              size='full-width'
              label={
                data.understanding.likely_off_topic
                  ? `“${data.query}” does not look like a topic this corpus covers. These people are closest by topic.`
                  : `No direct matches for “${data.query}”. These people are closest by topic.`
              }
            />
          </div>
        )}

        {q && data && !error && people.length === 0 && (
          // U10: one sentence, one block. This used to stack spec §7's copy on
          // top of EmptyStateTopics' own "No strong matches for …", each in its
          // own 32px padded block, saying the same thing twice in two framings.
          // That component's paragraph is document-framed; here the subject is
          // people. So it takes the sentence as a prop rather than being
          // reimplemented — spec §7's states table names this component, and
          // the chips-as-a-door behaviour is exactly what we want to share.
          <EmptyStateTopics
            query={q}
            topics={nearbyTopics}
            onPickTopic={(t) => router.push(buildUrl(t, null, []))}
            message='No one in the corpus has published near this.'
          />
        )}

        {/* M-5: never under the error banner. Spec §7's error state preserves
            the query and the chips, not the previous bench — a stale ranking
            below "we could not load people" reads as an answer to the question
            now in the box. */}
        {q && !error && data && people.length > 0 && (
          <div
            className='experts-bench'
            data-testid='experts-bench'
            style={{
              maxWidth: 1400,
              margin: '0 auto',
              padding: '18px 24px 48px',
              display: 'grid',
              gridTemplateColumns: 'minmax(380px, 460px) 1fr',
              gap: 20,
              alignItems: 'start',
              opacity: loading ? 0.6 : 1,
            }}
          >
            <section aria-labelledby='experts-list-h'>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  padding: '0 4px 10px',
                  borderBottom: '1px solid #E6E2D6',
                }}
              >
                <h2
                  id='experts-list-h'
                  style={{ fontSize: 14, fontWeight: 600, margin: 0 }}
                >
                  People closest to this question
                </h2>
                <span style={{ fontSize: 12, color: '#8A877E' }}>
                  {data.mode === 'evidence'
                    ? 'ranked by document evidence'
                    : 'ranked by topic'}
                </span>
              </div>
              <ExpertsList
                people={people}
                mode={data.mode}
                selectedKey={selectedKey}
                peerKeys={peerKeys}
                hoverTopic={hoverTopic}
                onHover={setHoverKey}
                onSelect={select}
              />
              <OrganizationsStrip organizations={organizations} />
            </section>
            <section aria-labelledby='experts-graph-h'>
              <div
                style={{
                  background: 'white',
                  border: '1px solid #E6E2D6',
                  borderRadius: 6,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap',
                    padding: '10px 14px',
                    borderBottom: '1px solid #E6E2D6',
                    fontSize: 12,
                    color: '#5E5B52',
                  }}
                >
                  <div>
                    <strong
                      id='experts-graph-h'
                      style={{ color: '#1b1a17', fontWeight: 600 }}
                    >
                      Topic space
                    </strong>{' '}
                    {' · '}
                    {topicsDegraded
                      ? 'people sized by relevance, topics from the matched documents\u2019 own tags'
                      : 'people sized by relevance, topics sized by match to the query'}
                  </div>
                  <div
                    aria-label='Office legend'
                    style={{
                      display: 'flex',
                      gap: 14,
                      flexWrap: 'wrap',
                      alignItems: 'center',
                    }}
                  >
                    {Object.entries(OFFICE_COLORS).map(([o, c]) => (
                      <span
                        key={o}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        <i
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: c,
                            display: 'inline-block',
                          }}
                        />
                        {o}
                      </span>
                    ))}
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <i
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: OTHER_OFFICE_COLOR,
                          display: 'inline-block',
                        }}
                      />
                      Other offices
                    </span>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <i
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          background: 'white',
                          border: '2px solid #B8800A',
                          display: 'inline-block',
                        }}
                      />
                      Topic
                    </span>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <i
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: OTHER_OFFICE_COLOR,
                          outline: '2px solid #1b1a17',
                          outlineOffset: 2,
                          display: 'inline-block',
                        }}
                      />
                      Selected person
                    </span>
                  </div>
                </div>
                <TopicGraph
                  people={people}
                  matched={matched}
                  topicsAreDerived={topicsDegraded}
                  hoverKey={hoverKey}
                  selectedKey={selectedKey}
                  peerKeys={peerKeys}
                  onHover={setHoverKey}
                  onSelect={select}
                  hoverTopic={hoverTopic}
                  onHoverTopic={setHoverTopic}
                />
              </div>
              {selectedPerson && (
                <ExpertEvidence
                  person={selectedPerson}
                  docs={data.docs}
                  peers={peers}
                  mode={data.mode}
                  matched={matched}
                  returnFocusTo={`expert-row-${encodeURIComponent(selectedPerson.key)}`}
                  onSelectPeer={select}
                  onClose={() => select(selectedPerson.key)}
                />
              )}
            </section>
          </div>
        )}
      </main>
    </>
  )
}

const ExpertsPage = () => (
  <Suspense
    fallback={
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Spinner />
      </div>
    }
  >
    <ExpertsPageContent />
  </Suspense>
)

export default ExpertsPage
