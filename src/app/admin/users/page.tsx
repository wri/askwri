'use client'

import { useCallback, useEffect, useState } from 'react'
import { Box, Heading } from '@chakra-ui/react'
import { adminFetch } from '../lib/api'
import { actionButton } from '../lib/buttonStyles'
import { Flash } from '../components/Flash'

interface AdminUser {
  id: string
  username: string
  email: string
  role: string
  active: boolean
  lastLogin: string | null
}

const cell: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid #eee',
}

const UsersPage = () => {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [createForm, setCreateForm] = useState({
    username: '',
    email: '',
    password: '',
    role: 'editor',
  })
  const [busyId, setBusyId] = useState<string | null>(null)
  const [createBusy, setCreateBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const body = await adminFetch<{ users: AdminUser[] }>('/api/admin/users')
      setUsers(body.users)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const patch = async (id: string, payload: Record<string, any>) => {
    setNotice(null)
    setError(null)
    setBusyId(id)
    try {
      await adminFetch(`/api/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const resetPassword = async (id: string, username: string) => {
    const pw = window.prompt(
      `New password for ${username} (min 12 characters):`,
    )
    if (pw === null) return
    if (pw.length < 12) {
      setError('Password must be at least 12 characters.')
      return
    }
    setNotice(null)
    setError(null)
    setBusyId(id)
    try {
      await adminFetch(`/api/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ password: pw }),
      })
      setNotice(`Password reset for ${username}.`)
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setNotice(null)
    setError(null)
    setCreateBusy(true)
    try {
      await adminFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify(createForm),
      })
      setCreateForm({ username: '', email: '', password: '', role: 'editor' })
      setNotice(`User "${createForm.username}" created.`)
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setCreateBusy(false)
    }
  }

  return (
    <Box>
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Users
      </Heading>

      <Flash
        notice={notice}
        error={error}
        onDismiss={() => {
          setNotice(null)
          setError(null)
        }}
      />

      <table
        style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 32 }}
      >
        <thead>
          <tr>
            {[
              'Username',
              'Email',
              'Role',
              'Active',
              'Last login',
              'Actions',
            ].map((h) => (
              <th
                key={h}
                style={{ ...cell, textAlign: 'left', background: '#f7f7f7' }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td style={cell}>{u.username}</td>
              <td style={cell}>{u.email}</td>
              <td style={cell}>
                <select
                  value={u.role}
                  disabled={busyId === u.id}
                  onChange={(e) => patch(u.id, { role: e.target.value })}
                  style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
                >
                  <option value='admin'>admin</option>
                  <option value='editor'>editor</option>
                </select>
              </td>
              <td style={cell}>{u.active ? 'Yes' : 'No'}</td>
              <td style={cell}>
                {u.lastLogin ? new Date(u.lastLogin).toLocaleDateString() : '—'}
              </td>
              <td style={cell}>
                <button
                  onClick={() => patch(u.id, { active: !u.active })}
                  disabled={busyId === u.id}
                  className='admin-btn'
                  style={{ ...actionButton, marginRight: 8 }}
                >
                  {u.active ? 'Deactivate' : 'Activate'}
                </button>
                <button
                  onClick={() => resetPassword(u.id, u.username)}
                  disabled={busyId === u.id}
                  className='admin-btn'
                  style={actionButton}
                >
                  Reset password
                </button>
              </td>
            </tr>
          ))}
          {loading ? (
            <tr>
              <td colSpan={6} style={cell}>
                Loading…
              </td>
            </tr>
          ) : users.length === 0 ? (
            <tr>
              <td colSpan={6} style={cell}>
                No users found.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {/* Create form */}
      <Heading size='md' style={{ marginBottom: 12 }}>
        New user
      </Heading>
      <form
        onSubmit={createUser}
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'flex-start',
        }}
      >
        <input
          placeholder='Username'
          value={createForm.username}
          onChange={(e) =>
            setCreateForm((f) => ({ ...f, username: e.target.value }))
          }
          required
          style={{
            fontFamily: 'inherit',
            fontSize: 'inherit',
            padding: '4px 8px',
          }}
        />
        <input
          placeholder='Email'
          type='email'
          value={createForm.email}
          onChange={(e) =>
            setCreateForm((f) => ({ ...f, email: e.target.value }))
          }
          required
          style={{
            fontFamily: 'inherit',
            fontSize: 'inherit',
            padding: '4px 8px',
          }}
        />
        <input
          placeholder='Password'
          type='password'
          value={createForm.password}
          onChange={(e) =>
            setCreateForm((f) => ({ ...f, password: e.target.value }))
          }
          required
          style={{
            fontFamily: 'inherit',
            fontSize: 'inherit',
            padding: '4px 8px',
          }}
        />
        <select
          value={createForm.role}
          onChange={(e) =>
            setCreateForm((f) => ({ ...f, role: e.target.value }))
          }
          style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
        >
          <option value='editor'>editor</option>
          <option value='admin'>admin</option>
        </select>
        <button
          type='submit'
          disabled={
            !createForm.username ||
            !createForm.email ||
            !createForm.password ||
            createBusy
          }
          className='admin-btn'
          style={actionButton}
        >
          Create
        </button>
      </form>
    </Box>
  )
}

export default UsersPage
