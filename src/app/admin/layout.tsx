'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Box, Heading } from '@chakra-ui/react'

const NAV = [
  { href: '/admin/review', label: 'Review queue' },
  { href: '/admin/documents', label: 'Documents' },
  { href: '/admin/collections', label: 'Collections' },
  { href: '/admin/tags', label: 'Tags' },
  { href: '/admin/upload', label: 'Upload' },
]

const AdminLayout = ({ children }: { children: React.ReactNode }) => {
  const pathname = usePathname()
  const router = useRouter()
  const [me, setMe] = useState<{ username?: string; role?: string } | null>(null)
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
      <Box style={{ width: 220, borderRight: '1px solid #ddd', padding: 16 }}>
        <Heading size='md' style={{ marginBottom: 16 }}>
          AskWRI Admin
        </Heading>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              style={{ fontWeight: pathname.startsWith(item.href) ? 700 : 400 }}
            >
              {item.label}
            </Link>
          ))}
          {me?.role === 'admin' && <Link href='/admin/users'>Users</Link>}
        </nav>
        <Box style={{ marginTop: 24, fontSize: 13 }}>
          {me?.username && <div>{me.username} ({me.role})</div>}
          <button onClick={logout} style={{ marginTop: 8, textDecoration: 'underline' }}>
            Log out
          </button>
        </Box>
      </Box>
      <Box style={{ flex: 1, padding: 24, overflowX: 'auto' }}>{children}</Box>
    </Box>
  )
}

export default AdminLayout
