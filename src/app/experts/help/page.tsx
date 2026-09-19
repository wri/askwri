'use client'

import Link from 'next/link'
import Navbar from '@/app/components/results/Navbar'
import '../../styles.css'

const INK = '#1b1a17'
const SOFT = '#5E5B52'

const Section = ({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) => (
  <section style={{ marginTop: 34 }}>
    <h2 style={{ fontSize: 17, fontWeight: 700, color: INK, marginBottom: 10 }}>
      {title}
    </h2>
    <div style={{ fontSize: 14.5, lineHeight: 1.65, color: SOFT }}>
      {children}
    </div>
  </section>
)

const Term = ({ children }: { children: React.ReactNode }) => (
  <strong style={{ color: INK, fontWeight: 600 }}>{children}</strong>
)

const ExpertsHelpPage = () => (
  <>
    {/* Unlisted, like the page it explains. */}
    <meta name='robots' content='noindex' />
    <Navbar query='' newSearchHref='/experts' />
    <main style={{ paddingTop: 64 }}>
      {/* Padding lives in the stylesheet, not here: an inline shorthand would
          set padding-bottom:0 and outrank the media queries that reserve room
          for the footer. */}
      <div className='experts-help-body'>
        <Link
          href='/experts'
          style={{ fontSize: 13, color: SOFT, textDecoration: 'underline' }}
        >
          ← Back to experts
        </Link>

        <h1
          style={{
            fontSize: 26,
            fontWeight: 700,
            color: INK,
            margin: '16px 0 6px',
          }}
        >
          How experts mode works
        </h1>
        <p style={{ fontSize: 14.5, lineHeight: 1.6, color: SOFT }}>
          Experts mode answers one question: whose published WRI work is closest
          to a topic. It is an internal prototype. Read the ranking as a place
          to start looking, not as a verdict about people.
        </p>

        <Section title='How to use it'>
          <p>
            Type a <Term>topic, method, or place</Term> rather than a question —
            &ldquo;electric school buses&rdquo; works better than &ldquo;who
            knows about electric school buses?&rdquo;
          </p>
          <p style={{ marginTop: 10 }}>
            The chips under the box show how your query was read. Remove one to
            re-rank without it, which is the fastest way to steer results when a
            topic has pulled the list somewhere you did not mean.
          </p>
          <p style={{ marginTop: 10 }}>
            Select anyone to see the documents behind their placement. The
            ranked list is the graph&rsquo;s twin — everything the graph does is
            reachable from the list with the keyboard alone.
          </p>
        </Section>

        <Section title='How to read the results'>
          <p>
            The gold bar is that person&rsquo;s score relative to the top
            result. The line beneath it summarises their matching work.
          </p>
          <p style={{ marginTop: 10 }} data-testid='help-works-counting'>
            <Term>It counts works, not files.</Term> A document and its
            confirmed translation are one piece of work, counted once. So
            &ldquo;6 of 27 documents match&rdquo; means six of the twenty-seven
            works we hold for that person matched your topic.
          </p>
          <p style={{ marginTop: 10 }}>
            Each matching document is labelled <Term>strong</Term>,{' '}
            <Term>partial</Term> or <Term>weak</Term>, describing how well that
            document answered the query — not how good the document is.
          </p>
          <p style={{ marginTop: 10 }}>
            In the graph, a larger circle means a higher score, colour is the
            person&rsquo;s office, and a line means they have published on that
            topic. <Term>Works alongside</Term> lists people whose publishing
            overlaps on the same specific topics — a shared interest, not a
            claim that they have co-authored anything.
          </p>
        </Section>

        <Section title='How the score works'>
          <p>
            Roughly{' '}
            <span data-testid='help-blend'>
              70% published evidence, 30% topic proximity
            </span>
            .
          </p>
          <p style={{ marginTop: 10 }}>
            The <Term>evidence</Term> part rewards documents that actually
            matched your query. A strong match counts for more than a partial
            one, a first author for more than a fifth, and recent work for more
            than old work.
          </p>
          <p style={{ marginTop: 10 }}>
            The <Term>topic</Term> part asks how close your query is to the
            topics someone publishes on, weighted heavily toward{' '}
            <Term>rare</Term> topics. A specific topic that few people work on
            says far more about expertise than a broad programme label attached
            to most of the library, so the broad label barely moves the ranking.
            Publishing a lot is not penalised: prolific and relevant is the
            signal we are looking for, which is why the evidence panel also
            shows how much of someone&rsquo;s output matched.
          </p>
        </Section>

        <Section title='What it cannot tell you'>
          <p data-testid='help-absence'>
            <Term>Not appearing means no matching publication.</Term> It does
            not mean they lack that expertise. Plenty of expertise never becomes
            a published WRI document — project work, review, advisory, teaching,
            and anything published elsewhere are all invisible here.
          </p>
          <p style={{ marginTop: 10 }} data-testid='help-untuned'>
            <Term>The ordering is provisional.</Term> The weights above are
            starting values that have not been tuned against a labelled set of
            questions with known right answers. Treat the people it surfaces as
            worth a look, and the exact order as not yet meaningful.
          </p>
          <p style={{ marginTop: 10 }}>
            It also has <Term>no contact details</Term>, and no review or
            correction history — nobody has checked these results, and there is
            no way for someone to correct their own entry. Author names come
            from document metadata, so a person whose name is recorded
            inconsistently can appear twice or not at all.
          </p>
        </Section>

        <p style={{ marginTop: 34, fontSize: 13.5, color: SOFT }}>
          Something look wrong? That is useful — send it to the AskWRI team with
          the query you typed, so the example can go into the labelled set the
          ranking still needs.
        </p>
      </div>
    </main>
  </>
)

export default ExpertsHelpPage
