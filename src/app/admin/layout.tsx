'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Box, Heading } from '@chakra-ui/react'

const NAV = [
  {
    href: '/admin/review',
    label: 'Review queue',
    help: 'Documents flagged for human review (low extraction confidence or worker errors). Promote to make them searchable, or re-ingest to retry.',
  },
  {
    href: '/admin/documents',
    label: 'Documents',
    help: 'The full document catalog. Filter by status, language, collection, or search by title/external ID/author/DOI.',
  },
  {
    href: '/admin/collections',
    label: 'Collections',
    help: 'Curated groups of documents (e.g. by topic or project). Used for bulk operations and organized browsing.',
  },
  {
    href: '/admin/tags',
    label: 'Tags',
    help: 'The controlled vocabulary (taxonomy v1). Facets: program, office, topic, doc_type. Admins can add/edit/delete values.',
  },
  {
    href: '/admin/upload',
    label: 'Upload',
    help: 'Upload PDFs to the intake queue. The ingestion worker registers and processes them (parse → language → summarize → classify → embed → publish).',
  },
  {
    href: '/admin/guide',
    label: 'Help',
    help: 'The admin guide — what each page does, document statuses, and how the ingestion pipeline works.',
  },
]

const AdminLayout = ({ children }: { children: React.ReactNode }) => {
  const pathname = usePathname()
  const router = useRouter()
  const [me, setMe] = useState<{ username?: string; role?: string } | null>(
    null,
  )
  const isLogin = pathname === '/admin/login'

  useEffect(() => {
    if (isLogin) return
    fetch('/api/admin/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => setMe(body?.identity ?? null))
      .catch(() => setMe(null))
  }, [isLogin, pathname])

  if (isLogin) return <>{children}</>

  const logout = async () => {
    await fetch('/api/admin/auth/logout', { method: 'POST' })
    router.push('/admin/login')
  }

  return (
    <Box style={{ display: 'flex', minHeight: '100vh' }}>
      <Box
        style={{
          width: 220,
          borderRight: '1px solid #ddd',
          padding: 16,
          background: '#1a365d',
        }}
      >
        {/* AskWRI branded wordmark */}
        <Heading size='md' style={{ marginBottom: 16, color: '#fff' }}>
          <span style={{ fontWeight: 800 }}>AskWRI</span>{' '}
          <span style={{ fontWeight: 400, fontSize: '0.8em', opacity: 0.8 }}>
            Admin
          </span>
        </Heading>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              title={item.help}
              style={{
                fontWeight: pathname.startsWith(item.href) ? 700 : 400,
                color: pathname.startsWith(item.href) ? '#90cdf4' : '#cbd5e0',
                textDecoration: 'none',
              }}
            >
              {item.label}
            </Link>
          ))}
          {me?.role === 'admin' && (
            <Link
              href='/admin/import'
              title='Upload a CSV to bulk-create or update document metadata. Preview (dry-run) shows what would change before applying.'
              style={{ color: '#cbd5e0', textDecoration: 'none' }}
            >
              Import
            </Link>
          )}
          {me?.role === 'admin' && (
            <Link
              href='/admin/users'
              style={{ color: '#cbd5e0', textDecoration: 'none' }}
            >
              Users
            </Link>
          )}
        </nav>
        <Box style={{ marginTop: 24, fontSize: 13, color: '#cbd5e0' }}>
          {me?.username && (
            <div
              title={
                me.role === 'admin'
                  ? 'Admin: everything an editor can do, plus withdraw/restore/delete documents, delete tags, CSV import, and user management.'
                  : 'Editor: review, edit metadata and summaries, manage tags and collections, upload PDFs.'
              }
            >
              {me.username} ({me.role})
            </div>
          )}
          <button
            onClick={logout}
            style={{
              marginTop: 8,
              textDecoration: 'underline',
              color: '#cbd5e0',
              cursor: 'pointer',
            }}
          >
            Log out
          </button>
        </Box>
      </Box>
      <Box style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Box style={{ flex: 1, padding: 24, overflowX: 'auto' }}>
          {children}
        </Box>
        {/* Footer with admin guide link */}
        <Box
          style={{
            padding: '12px 24px',
            borderTop: '1px solid #eee',
            fontSize: 13,
            color: '#888',
          }}
        >
          <Link href='/admin/guide' style={{ textDecoration: 'underline' }}>
            Admin Guide
          </Link>
          {' · '}
          <a
            href='https://github.com/wri/AskWRI'
            style={{ textDecoration: 'underline' }}
          >
            AskWRI
          </a>
          {' · '}
          Document Management System
        </Box>
      </Box>
    </Box>
  )
}

export default AdminLayout
