'use client'

/**
 * StatusChip — a document lifecycle status with a plain-language hover
 * explanation. Use everywhere a raw status string would otherwise appear.
 */
export const STATUS_META: Record<
  string,
  { color: string; bg: string; help: string }
> = {
  // exported: the /admin/guide page renders this map as the status glossary table
  draft: {
    color: '#555',
    bg: '#eee',
    help: 'Registered but not yet processed by the ingestion pipeline. Not publicly searchable.',
  },
  processing: {
    color: '#0050C8',
    bg: '#e6f0ff',
    help: 'The ingestion pipeline is currently working on this document.',
  },
  needs_review: {
    color: '#8a5a15',
    bg: '#fdf3e0',
    help: 'Held for human review — the PDF may not have parsed cleanly. Not publicly searchable until a person promotes it.',
  },
  searchable: {
    color: '#0A6640',
    bg: '#e4f2ea',
    help: 'Live in the public search corpus — users can find and read it.',
  },
  withdrawn: {
    color: '#C11101',
    bg: '#fdeaea',
    help: 'Removed from public search by an admin. The document still exists and an admin can restore it.',
  },
  error: {
    color: '#C11101',
    bg: '#fdeaea',
    help: 'Ingestion failed after retries. Open the document to see the error, then re-ingest.',
  },
}

export const StatusChip = ({ status }: { status: string }) => {
  const meta = STATUS_META[status]
  return (
    <span
      title={meta?.help}
      style={{
        background: meta?.bg ?? '#eee',
        color: meta?.color ?? '#555',
        borderRadius: 4,
        padding: '2px 8px',
        fontSize: 12,
        fontWeight: 600,
        cursor: meta ? 'help' : 'default',
        whiteSpace: 'nowrap',
      }}
    >
      {status}
    </span>
  )
}

export default StatusChip
