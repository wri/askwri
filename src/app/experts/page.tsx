'use client'

import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Spinner } from '@chakra-ui/react'
import {
  AlertBanner,
  Button,
  Tag,
  Textarea,
} from '@worldresources/wri-design-systems'
import { FaArrowRightLong } from 'react-icons/fa6'
import Navbar from '@/app/components/results/Navbar'
import QuerySuggestions from '@/app/components/QuerySuggestions'
import { EmptyStateTopics } from '@/app/components/results/EmptyStateTopics'
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
import { peersOf } from '@/lib/experts/peers'
import type { ExpertsResponse } from '@/lib/experts/types'
import '../styles.css'

// encodeURIComponent, not URLSearchParams: the latter writes '+' for spaces,
// and the tests (and shared links) expect %20.
function buildUrl(q: string, person: string | null, exclude: string[]): string {
  const parts = [`q=${encodeURIComponent(q)}`]
  if (person) parts.push(`person=${encodeURIComponent(person)}`)
  if (exclude.length)
    parts.push(`exclude=${encodeURIComponent(exclude.join(','))}`)
  return `/experts?${parts.join('&')}`
}

const ExpertsPageContent = () => {
  const router = useRouter()
  const searchParams = useSearchParams()
  const q = searchParams?.get('q')?.trim() ?? ''
  const personParam = searchParams?.get('person') ?? null
  // Depend on the STRING, not the searchParams object: a new object per render
  // would re-fire the fetch effect forever.
  const excludeRaw = searchParams?.get('exclude') ?? ''
  const excludeParam = useMemo(
    () =>
      excludeRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    [excludeRaw],
  )

  const [draft, setDraft] = useState(q)
  const [excluded, setExcluded] = useState<string[]>(excludeParam)
  const [data, setData] = useState<ExpertsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(personParam)
  const loggedFor = useRef<string | null>(null)

  const run = useCallback(async (query: string, excluded: string[]) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetchExperts({ query, excluded_topics: excluded })
      setData(res)
    } catch (e: any) {
      setError(e?.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!q) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- URL is the source of truth; reset cached results when q is cleared
      setData(null)
      return
    }
    setDraft(q)
    setExcluded(excludeParam)
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
    router.push(buildUrl(q, next, excluded))
    // jsdom has no scrollIntoView; optional-call keeps tests honest.
    if (next)
      document
        .getElementById(`expert-row-${encodeURIComponent(next)}`)
        ?.scrollIntoView?.({ block: 'nearest' })
  }
  // Chip removal is local state + a URL update + a re-fetch, so it works
  // without waiting for a navigation round-trip (spec §5.1 excluded_topics).
  const removeTopic = (label: string) => {
    const next = [...excluded, label]
    setExcluded(next)
    setSelectedKey(null)
    router.push(buildUrl(q, null, next))
    run(q, next)
  }

  const people = data?.people ?? []
  const matched = data?.understanding.matched_topics ?? []
  const totalWorks = useMemo(() => Object.keys(data?.docs ?? {}).length, [data])
  const activeKey = selectedKey ?? hoverKey
  const activePerson = activeKey
    ? (people.find((p) => p.key === activeKey) ?? null)
    : null
  const peers = useMemo(
    () =>
      activePerson
        ? peersOf(activePerson, people, matched, Math.max(totalWorks, 1))
        : [],
    [activePerson, people, matched, totalWorks],
  )
  const peerKeys = useMemo(() => new Set(peers.map((p) => p.key)), [peers])
  const selectedPerson = selectedKey
    ? (people.find((p) => p.key === selectedKey) ?? null)
    : null
  const offices = useMemo(() => new Set(people.map((p) => p.office)), [people])

  return (
    <>
      {/* React 19 hoists <meta> rendered anywhere into <head>. Unlisted page. */}
      <meta name='robots' content='noindex' />
      <Navbar query={q} />
      <main style={{ paddingTop: 64 }}>
        <AlertBanner title='For WRI staff use only' variant='warning'>
          <div style={{ textAlign: 'left' }}>
            Experts mode is an internal prototype. It ranks people by their
            published WRI work only; it has no contact details and no review or
            correction history.
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
            {data && (
              <TopicChips
                topics={matched}
                geographies={data.understanding.matched_geographies}
                onRemove={removeTopic}
              />
            )}
            {data && people.length > 0 && (
              // One text node: the test's getByText regex can only match a
              // single element's direct text, so no nested <b> around numbers.
              <p style={{ marginTop: 10, fontSize: 13, color: '#5E5B52' }}>
                {`${data.total_people} people across ${offices.size} offices, on ${totalWorks} documents that match. Showing the top ${people.length}.`}
              </p>
            )}
          </div>
        </section>

        {q && error && (
          <div
            role='alert'
            style={{
              maxWidth: 1400,
              margin: '18px auto',
              padding: '12px 24px',
              display: 'flex',
              gap: 12,
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: 14, color: '#a33' }}>{error}</span>
            <Button
              variant='secondary'
              size='small'
              onClick={() => run(q, excluded)}
            >
              Retry
            </Button>
          </div>
        )}

        {q && loading && !data && (
          <div
            style={{
              minHeight: '40vh',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Spinner />
          </div>
        )}

        {q && data && data.mode === 'topic_only' && people.length > 0 && (
          <p
            style={{
              maxWidth: 1400,
              margin: '12px auto 0',
              padding: '8px 24px',
              fontSize: 14,
              color: '#8a6d3b',
              background: '#fcf8e3',
              border: '1px solid #faebcc',
              borderRadius: 4,
            }}
          >
            No direct matches for “{data.query}”. These people are closest by
            topic.
          </p>
        )}

        {q && data && !error && people.length === 0 && (
          <div style={{ padding: '32px', textAlign: 'center' }}>
            <p style={{ fontSize: 16, marginBottom: 12 }}>
              No one in the corpus has published near this.
            </p>
            <EmptyStateTopics
              query={data.query}
              topics={data.understanding.suggestions
                .filter((s) => s.type === 'nearby_topic')
                .map((s) => s.text)}
              onPickTopic={(t) => router.push(buildUrl(t, null, []))}
            />
          </div>
        )}

        {q && data && people.length > 0 && (
          <div
            className='experts-bench'
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
                onHover={setHoverKey}
                onSelect={select}
              />
              <OrganizationsStrip organizations={data.organizations} />
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
                    · people sized by relevance, topics sized by match to the
                    query
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
                  totalWorks={totalWorks}
                  hoverKey={hoverKey}
                  selectedKey={selectedKey}
                  peerKeys={peerKeys}
                  onHover={setHoverKey}
                  onSelect={select}
                />
              </div>
              {selectedPerson && (
                <ExpertEvidence
                  person={selectedPerson}
                  docs={data.docs}
                  peers={peers}
                  mode={data.mode}
                  matched={matched}
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
