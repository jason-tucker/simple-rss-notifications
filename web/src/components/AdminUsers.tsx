'use client'

import { useState } from 'react'
import { Badge, Button, Card, CheckboxRow, Field, Input } from '@/components/ui'

export interface AdminUser {
  id: string
  username: string
  is_admin: boolean
  must_change_password: boolean
  created_at: string
}

const ERRORS: Record<string, string> = {
  'username-taken': 'That username is already taken.',
  'invalid-username': 'Usernames must start with a letter or number and use only a–z, 0–9, dot, dash or underscore.',
  'last-admin': "You can't remove the last admin — promote another user first.",
  'cannot-delete-self': "You can't delete your own account.",
  'cannot-demote-self': "You can't remove your own admin role — another admin has to do it.",
  'rate-limited': 'Too many requests — slow down a moment and try again.',
  'bad-request': 'Some fields were invalid.',
  forbidden: 'You are not allowed to do that.',
  unauthorized: 'Your session expired — sign in again.',
}

function explain(code: string | undefined, status: number): string {
  if (code && ERRORS[code]) return ERRORS[code]
  return `Request failed (${status}).`
}

export function AdminUsers({ currentUserId, initialUsers }: { currentUserId: string; initialUsers: AdminUser[] }) {
  const [users, setUsers] = useState<AdminUser[]>(initialUsers)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Create-form state.
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [makeAdmin, setMakeAdmin] = useState(false)
  const [forceChange, setForceChange] = useState(false)

  async function refresh() {
    const res = await fetch('/api/users', { headers: { accept: 'application/json' } })
    if (res.ok) {
      const body = (await res.json()) as { users: AdminUser[] }
      setUsers(body.users)
    }
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          is_admin: makeAdmin,
          must_change_password: forceChange,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string }
        setError(explain(body.code, res.status))
        return
      }
      setNotice(`Created ${username.trim().toLowerCase()}.`)
      setUsername('')
      setPassword('')
      setMakeAdmin(false)
      setForceChange(false)
      await refresh()
    } catch {
      setError('Network error.')
    } finally {
      setBusy(false)
    }
  }

  async function patchUser(id: string, payload: Record<string, unknown>, okMsg: string) {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const res = await fetch(`/api/users/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string }
        setError(explain(body.code, res.status))
        return
      }
      setNotice(okMsg)
      await refresh()
    } catch {
      setError('Network error.')
    } finally {
      setBusy(false)
    }
  }

  async function deleteUser(u: AdminUser) {
    if (!confirm(`Delete "${u.username}"? This permanently removes their feeds, routes, sinks and history. This cannot be undone.`)) {
      return
    }
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const res = await fetch(`/api/users/${u.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string }
        setError(explain(body.code, res.status))
        return
      }
      setNotice(`Deleted ${u.username}.`)
      await refresh()
    } catch {
      setError('Network error.')
    } finally {
      setBusy(false)
    }
  }

  function resetPassword(u: AdminUser) {
    const pw = prompt(`New password for "${u.username}" (min 8 characters):`)
    if (pw === null) return
    if (pw.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    void patchUser(u.id, { password: pw, must_change_password: true }, `Password reset for ${u.username}.`)
  }

  return (
    <div className="space-y-8">
      <Card className="p-4">
        <h2 className="text-sm font-medium text-zinc-300">Add a user</h2>
        <form onSubmit={createUser} className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Username">
              <Input
                required
                maxLength={64}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. tommy"
                autoComplete="off"
              />
            </Field>
            <Field label="Password">
              <Input
                required
                type="password"
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="at least 8 characters"
                autoComplete="new-password"
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-4">
            <CheckboxRow label="Make admin" checked={makeAdmin} onChange={(e) => setMakeAdmin(e.target.checked)} />
            <CheckboxRow label="Require password change on first login" checked={forceChange} onChange={(e) => setForceChange(e.target.checked)} />
          </div>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Working…' : 'Create user'}
          </Button>
        </form>
      </Card>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && <p className="text-sm text-emerald-400">{notice}</p>}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-300">Users ({users.length})</h2>
        <ul className="divide-y divide-zinc-800 overflow-hidden rounded-lg border border-zinc-800">
          {users.map((u) => {
            const self = u.id === currentUserId
            return (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 bg-zinc-900/60 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-100">{u.username}</span>
                    {self && <span className="text-xs text-zinc-500">(you)</span>}
                    {u.is_admin && <Badge tone="info">admin</Badge>}
                    {u.must_change_password && <Badge tone="warn">must change pw</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    created {new Date(u.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!self && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        patchUser(
                          u.id,
                          { is_admin: !u.is_admin },
                          `${u.username} is ${u.is_admin ? 'no longer' : 'now'} an admin.`,
                        )
                      }
                    >
                      {u.is_admin ? 'Remove admin' : 'Make admin'}
                    </Button>
                  )}
                  <Button size="sm" disabled={busy} onClick={() => resetPassword(u)}>
                    Reset password
                  </Button>
                  {!self && (
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => deleteUser(u)}>
                      Delete
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
