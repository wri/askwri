'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Box, Heading, Text } from '@chakra-ui/react'

const LoginForm = () => {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error || 'login failed')
        return
      }
      const next = searchParams.get('next') || ''
      router.push(
        next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
          ? next
          : '/admin/review',
      )
    } catch {
      setError('network error — is the server up?')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box style={{ maxWidth: 360, margin: '120px auto' }}>
      <Heading size='lg' style={{ marginBottom: 16 }}>
        AskWRI Admin
      </Heading>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input
          placeholder='Username'
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          style={{ padding: 8, border: '1px solid #ccc', borderRadius: 4 }}
        />
        <input
          placeholder='Password'
          type='password'
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ padding: 8, border: '1px solid #ccc', borderRadius: 4 }}
        />
        <button
          type='submit'
          disabled={busy || !username || !password}
          style={{ padding: 10, background: '#0A3C5C', color: 'white', borderRadius: 4 }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <Text style={{ color: '#C11101' }}>{error}</Text>}
      </form>
    </Box>
  )
}

const LoginPage = () => (
  <Suspense>
    <LoginForm />
  </Suspense>
)

export default LoginPage
