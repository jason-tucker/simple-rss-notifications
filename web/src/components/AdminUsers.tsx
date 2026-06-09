'use client'

import { useState } from 'react'

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

const inputCls =
  'mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-500'

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
      <section className="rounded border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="text-sm font-medium text-zinc-300">Add a user</h2>
        <form onSubmit={createUser} className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm text-zinc-400">Username</span>
              <input
                required
                maxLength={64}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className={inputCls}
                placeholder="e.g. tommy"
                autoComplete="off"
              />
            </label>
            <label className="block">
              <span className="text-sm text-zinc-400">Password</span>
              <input
                required
                type="password"
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
                placeholder="at least 8 characters"
                autoComplete="new-password"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={makeAdmin} onChange={(e) => setMakeAdmin(e.target.checked)} />
              <span>Make admin</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={forceChange} onChange={(e) => setForceChange(e.target.checked)} />
              <span>Require password change on first login</span>
            </label>
          </div>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-zinc-100 px-4 py-2 font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Create user'}
          </button>
        </form>
      </section>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && <p className="text-sm text-emerald-400">{notice}</p>}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-300">Users ({users.length})</h2>
        <ul className="divide-y divide-zinc-800 rounded border border-zinc-800">
          {users.map((u) => {
            const self = u.id === currentUserId
            return (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-100">{u.username}</span>
                    {self && <span className="text-xs text-zinc-500">(you)</span>}
                    {u.is_admin && (
                      <span className="rounded bg-indigo-950 px-1.5 py-0.5 text-xs text-indigo-300 ring-1 ring-indigo-800">
                        admin
                      </span>
                    )}
                    {u.must_change_password && (
                      <span className="rounded bg-amber-950 px-1.5 py-0.5 text-xs text-amber-300 ring-1 ring-amber-800">
                        must change pw
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    created {new Date(u.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {!self && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        patchUser(
                          u.id,
                          { is_admin: !u.is_admin },
                          `${u.username} is ${u.is_admin ? 'no longer' : 'now'} an admin.`,
                        )
                      }
                      className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
                    >
                      {u.is_admin ? 'Remove admin' : 'Make admin'}
                    </button>
                  )}
                  <button
                    disabled={busy}
                    onClick={() => resetPassword(u)}
                    className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
                  >
                    Reset password
                  </button>
                  {!self && (
                    <button
                      disabled={busy}
                      onClick={() => deleteUser(u)}
                      className="rounded border border-red-900 px-2 py-1 text-red-300 hover:border-red-700 disabled:opacity-50"
                    >
                      Delete
                    </button>
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
