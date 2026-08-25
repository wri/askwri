'use client'

import { StatusChip, STATUS_META } from '../components/StatusChip'
import { PROVENANCE_LABEL } from '@/lib/metadataProvenance'

const PROVENANCE_BADGE: Record<string, string> = {
  human: 'person',
  external: 'imported',
  llm: 'AI',
}

const GuidePage = () => (
  <div style={{ maxWidth: 860 }}>
    <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 4 }}>
      AskWRI Admin Guide
    </h1>
    <p style={{ marginBottom: 24, color: '#555' }}>
      What each page does, what a document&apos;s lifecycle state means, and how
      the ingestion pipeline turns an uploaded PDF into a searchable document.
    </p>

    <h2
      style={{
        fontSize: '1.2rem',
        fontWeight: 700,
        marginTop: 24,
        marginBottom: 8,
      }}
    >
      Typical workflow
    </h2>
    <p style={{ marginBottom: 8 }}>
      Upload one or more PDFs on the Upload page. The ingestion pipeline picks
      them up and works through them in the background: it reads the PDF text
      (parse), detects the language, writes summaries, suggests tags (classify),
      and indexes the document for search (embed). Every new document then lands
      in the Review queue. Open it from there (or from Documents) to check its
      metadata and the tags the AI suggested, then click Promote to make it
      publicly searchable.
    </p>
    <p>
      If you have metadata for many documents at once — from a spreadsheet or
      another system of record — admins can use Import to bulk-update metadata
      by CSV instead of editing documents one at a time.
    </p>

    <h2
      style={{
        fontSize: '1.2rem',
        fontWeight: 700,
        marginTop: 24,
        marginBottom: 8,
      }}
    >
      Document statuses
    </h2>
    <p style={{ marginBottom: 8 }}>
      Every document is in exactly one of these states. Hover a status chip
      anywhere in the admin UI to see this same explanation.
    </p>
    <table
      style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}
    >
      <tbody>
        {Object.entries(STATUS_META).map(([status, meta]) => (
          <tr key={status} style={{ borderBottom: '1px solid #eee' }}>
            <td style={{ padding: '6px 12px 6px 0', verticalAlign: 'top' }}>
              <StatusChip status={status} />
            </td>
            <td style={{ padding: '6px 0', verticalAlign: 'top' }}>
              {meta.help}
            </td>
          </tr>
        ))}
      </tbody>
    </table>

    <h2
      style={{
        fontSize: '1.2rem',
        fontWeight: 700,
        marginTop: 24,
        marginBottom: 8,
      }}
    >
      Who last set each field
    </h2>
    <p style={{ marginBottom: 8 }}>
      Metadata fields and tags carry a badge showing who last set them: person
      (a human edited it), imported (it came from a CSV import), or AI (the
      pipeline extracted it from the PDF).
    </p>
    <table
      style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}
    >
      <tbody>
        {Object.entries(PROVENANCE_LABEL).map(([source, label]) => (
          <tr key={source} style={{ borderBottom: '1px solid #eee' }}>
            <td
              style={{
                padding: '6px 12px 6px 0',
                verticalAlign: 'top',
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              {PROVENANCE_BADGE[source] ?? source}
            </td>
            <td style={{ padding: '6px 0', verticalAlign: 'top' }}>{label}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <p>
      The overwrite rules follow from that badge: a field edited by a person is
      permanent — nothing automated will ever change it again. A field imported
      from a CSV survives re-ingestion, but a later CSV import can still update
      it. A field the AI extracted is refreshed every time the document is
      re-ingested, so it always reflects the most recent pipeline run. The same
      rules apply to AI-generated summaries: re-ingesting a document regenerates
      AI summaries and AI-extracted metadata, but never touches anything a
      person has edited by hand.
    </p>

    <h2
      style={{
        fontSize: '1.2rem',
        fontWeight: 700,
        marginTop: 24,
        marginBottom: 8,
      }}
    >
      Pages
    </h2>
    <p style={{ marginBottom: 8 }}>
      <strong>Review queue</strong> — documents the pipeline flagged for human
      review, usually because the PDF text didn&apos;t extract cleanly. A
      corpus-health panel at the top shows worker status, counts by status and
      language, and documents missing a required rendition. Promote moves a
      document to searchable; Re-ingest re-queues it for another pass through
      the pipeline.
    </p>
    <p style={{ marginBottom: 8 }}>
      <strong>Documents</strong> — the full catalog. Filter by status, language,
      or collection, or search by title, external ID, author, or DOI. Click any
      row to open the document editor.
    </p>
    <p style={{ marginBottom: 8 }}>
      <strong>Document editor</strong> — edit a document&apos;s metadata (title,
      DOI, authors, URL, dates, publication, office, language) and its
      long/short summaries in both the native language and English. Tags are
      grouped by facet, where you can accept or reject AI-suggested tags or add
      your own. The lifecycle panel shows extraction confidence and the current
      status, with buttons to promote, withdraw, restore (admins, for withdrawn
      documents), re-ingest, or open the source PDF. Admins also see a Delete
      button, which permanently removes the document, its search index entries,
      and its stored PDF — this cannot be undone.
    </p>
    <p style={{ marginBottom: 8 }}>
      <strong>Collections</strong> — curated groups of documents, for example by
      topic or project. A document can belong to more than one collection, and
      collections are used for bulk operations and organized browsing.
    </p>
    <p style={{ marginBottom: 8 }}>
      <strong>Tags</strong> — the controlled vocabulary, organized into facets:
      program, office, topic, and document type. AI-suggested tags stay pending
      until an editor accepts or rejects them; once a person makes that call the
      tag is protected from future automated changes. The Topic facet has a full
      management surface (see Topic taxonomy management below); the other facets
      use a simple table on the same Tags page.
    </p>
    <p style={{ marginBottom: 8 }}>
      <strong>Upload</strong> — drop PDFs into the intake queue. A status panel
      shows whether the ingestion worker is running; identical files (matched by
      content, not filename) are silently skipped as duplicates rather than
      re-processed.
    </p>
    <p style={{ marginBottom: 8 }}>
      <strong>Import</strong> (admins) — bulk-update document metadata from a
      CSV. Rows are matched to existing documents by external_id first, then by
      DOI. Always run Preview first to see a dry-run of what would change before
      clicking Apply; fields a person has already edited are protected and will
      not be overwritten by the import.
    </p>
    <p>
      <strong>Users</strong> (admins) — create and manage admin and editor
      accounts.
    </p>

    <h2
      style={{
        fontSize: '1.2rem',
        fontWeight: 700,
        marginTop: 24,
        marginBottom: 8,
      }}
    >
      Topic taxonomy management
    </h2>
    <p style={{ marginBottom: 8 }}>
      The Topic facet has its own management surface — the Topic Taxonomy
      Manager — rendered as the Topic tab on the Tags page (and deep-linkable at
      /admin/topics). Program, office, and document-type facets stay on the
      simple table view on the same page.
    </p>
    <p style={{ marginBottom: 8 }}>
      <strong>Browsing and editing.</strong> The topic list renders as a
      collapsible tree when parents are set, or a flat sorted list when no topic
      has a parent. Search and filter are client-side. Click any topic to open
      an inline edit drawer with its label, description, aliases (synonyms the
      classifier treats as the same concept), and parent (with a guard against
      creating a cycle). A History tab in the drawer shows every change to that
      topic — who changed what, when, and the before/after values.
    </p>
    <p style={{ marginBottom: 8 }}>
      <strong>Bulk operations.</strong> Multi-select topics to Merge (fold
      several into one, preserving any human-set document tags and moving
      aliases and children to the survivor), Re-parent (set a new parent for the
      selected subtree), or Delete unused (removes only topics with zero
      documents and no children; the rest are flagged so you can resolve them
      first).
    </p>
    <p style={{ marginBottom: 8 }}>
      <strong>CSV import and export.</strong> Export downloads the current
      taxonomy as CSV. Import expects a specific managed format with the header{' '}
      <code>label,description,aliases,parent,facet,id</code> — open the import,
      pick a file, and it runs a dry-run diff first (added, updated, unchanged,
      conflicts) that you confirm before anything is applied. Applying is
      atomic: every change commits or none do. A raw WRI keyword CSV (one
      keyword per line, no header) is not this format — convert it first with{' '}
      <code>
        npm run --silent convert:wri-keywords -- file.csv &gt; managed.csv
      </code>{' '}
      and import the result. (This is the documented one-time seed step for the
      WRI keyword list.)
    </p>
    <p style={{ marginBottom: 8 }}>
      <strong>Re-classify.</strong> Re-classify re-runs the AI topic classifier
      over documents you choose — all documents, or scoped to the documents
      tagged with a specific topic. It never overwrites tags a person set. The
      status panel shows queued, running, done, and error counts per run, recent
      runs grouped together, and an estimated cost (about $0.0008 per document)
      before you start. Use it after renaming or merging topics, or after
      importing new ones, to refresh how the corpus is tagged against the
      updated vocabulary.
    </p>
    <p style={{ marginBottom: 8 }}>
      <strong>Embeddings.</strong> Topic tags are embedded (cohere-embed-v4) so
      the classifier can rank candidate topics by similarity to a document.
      Embeddings are built and maintained by the ingestion worker, not the app —
      after an import or an edit, new and changed topics are flagged for
      embedding and the worker builds them on its next sweep. The{' '}
      <code>Embeddings: embedded/total (pending N)</code> indicator next to
      Rebuild embeddings shows progress; amber while pending, green when every
      topic has an embedding. Rebuild embeddings re-flags any topic lacking an
      embedding row for the worker to pick up.
    </p>

    <h2
      style={{
        fontSize: '1.2rem',
        fontWeight: 700,
        marginTop: 24,
        marginBottom: 8,
      }}
    >
      The ingestion pipeline &amp; re-ingest
    </h2>
    <p style={{ marginBottom: 8 }}>
      Once a PDF is uploaded, the worker moves it through six stages: read the
      PDF text (parse), detect the language, write summaries, suggest tags
      (classify), index the document for search (embed), and a final quality
      gate (publish) that records an extraction-confidence score. Every document
      then waits in needs_review — nothing goes live until a person reviews and
      promotes it. If a stage fails it retries automatically before the document
      is marked error.
    </p>
    <p>
      Re-ingesting a document runs it through this pipeline again. AI-written
      summaries and AI-extracted metadata are regenerated from the current PDF,
      so re-ingest is the right move after a parsing problem is fixed. Anything
      a person has edited by hand — a corrected title, a rewritten summary, an
      accepted or rejected tag — is preserved exactly as it was set and is never
      overwritten by re-ingestion. A document that was already publicly
      searchable comes back searchable after re-ingest (it is not pulled from
      search) unless the new extraction looks degraded, in which case it lands
      in needs_review for a person to check first.
    </p>

    <h2
      style={{
        fontSize: '1.2rem',
        fontWeight: 700,
        marginTop: 24,
        marginBottom: 8,
      }}
    >
      FAQ
    </h2>
    <p style={{ marginBottom: 4 }}>
      <strong>I uploaded a file and it never appeared.</strong>
    </p>
    <p style={{ marginBottom: 12 }}>
      Two common causes: the file is a duplicate of one already in the system
      (identical files are silently skipped), or the ingestion worker isn&apos;t
      running. Check the worker-status panel on the Upload page — if it shows
      stale, the worker is down and files will sit unprocessed until it comes
      back up.
    </p>
    <p style={{ marginBottom: 4 }}>
      <strong>My PDF is over 100MB and won&apos;t upload.</strong>
    </p>
    <p style={{ marginBottom: 12 }}>
      Uploads are capped at 100MB. You do not need to compress anything below
      that: files too large for the OCR service are downsampled automatically
      before processing, and the original you uploaded is what gets stored and
      served. If your file is over 100MB, compress it first: in Adobe Acrobat
      use File → Reduce File Size (or Save as Other → Optimized PDF); on a Mac,
      open the PDF in Preview and export with the &quot;Reduce File Size&quot;
      Quartz filter; or use a reputable web compressor such as iLovePDF or
      Smallpdf (fine here — these are published, public documents). Nearly all
      the bulk in a large report is imagery, so downsampling images typically
      shrinks it several-fold with no visible loss in the text.
    </p>
    <p style={{ marginBottom: 4 }}>
      <strong>The Promote button is missing.</strong>
    </p>
    <p style={{ marginBottom: 12 }}>
      Promote only appears for documents in needs_review status — it moves a
      reviewed document into searchable. A withdrawn document can&apos;t be
      promoted; an admin has to Restore it first.
    </p>
    <p style={{ marginBottom: 4 }}>
      <strong>What does confidence mean?</strong>
    </p>
    <p style={{ marginBottom: 12 }}>
      Extraction confidence is a score from 0 to 1 for how cleanly the PDF text
      was extracted. All documents wait in needs_review for a human check before
      they go live; a score below 0.7 is a signal to look extra closely at the
      extracted text and metadata.
    </p>
    <p style={{ marginBottom: 4 }}>
      <strong>Who can do what?</strong>
    </p>
    <p style={{ marginBottom: 12 }}>
      Editors can review documents, edit metadata and summaries, manage tags and
      collections, and upload PDFs. Admins can do everything an editor can do,
      plus withdraw and restore documents, delete documents, delete tags, run
      CSV imports, re-classify, rebuild embeddings, and manage user accounts.
    </p>
    <p style={{ marginBottom: 4 }}>
      <strong>
        I imported a WRI keyword CSV and got hundreds of &quot;empty label&quot;
        conflicts.
      </strong>
    </p>
    <p style={{ marginBottom: 12 }}>
      The import expects the managed CSV format (header{' '}
      <code>label,description,aliases,parent,facet,id</code>). A raw WRI keyword
      file is headerless — one keyword per line — so the importer reads line 1
      as the header and finds no label column. Convert it first:{' '}
      <code>
        npm run --silent convert:wri-keywords -- keywords.csv &gt; managed.csv
      </code>
      , then import managed.csv. The converter is the documented one-time seed
      step.
    </p>
    <p style={{ marginBottom: 4 }}>
      <strong>
        New topics I added aren&apos;t showing up as AI suggestions on
        documents.
      </strong>
    </p>
    <p style={{ marginBottom: 12 }}>
      New and edited topics are flagged for embedding and built by the ingestion
      worker on its next sweep, not immediately. Until a topic has an embedding,
      it isn&apos;t a candidate for the classifier. Watch the{' '}
      <code>Embeddings: embedded/total (pending N)</code> indicator on the Tags
      page — once it settles to 0 pending, all topics are candidates. To speed
      it up, Rebuild embeddings re-flags everything lacking an embedding; then
      re-classify the documents to refresh their tags.
    </p>
    <p style={{ marginBottom: 4 }}>
      <strong>What does Re-classify cost, and when should I run it?</strong>
    </p>
    <p>
      Re-classify makes one LLM call per document (about $0.0008 each at current
      models) to re-pick up to five topic tags from the candidate set. Run it
      after you rename or merge topics, or after a big import, to refresh how
      the corpus is tagged against the updated vocabulary. You can run it across
      all documents or scoped to just the ones tagged with a specific topic; the
      status panel shows the estimated cost before you start and tracks each
      run.
    </p>
  </div>
)

export default GuidePage
