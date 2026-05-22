'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function ChangePasswordPage() {
  const router = useRouter()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (next.length < 12) {
      setError('New password must be at least 12 characters.')
      return
    }
    if (next !== confirm) {
      setError('New password and confirmation do not match.')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current_password: current, new_password: next }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string }
        if (body.code === 'invalid-credentials') setError('Current password is wrong.')
        else if (body.code === 'same-password') setError('New password must be different from the current one.')
        else if (body.code === 'rate-limited') setError('Too many attempts. Wait a minute and try again.')
        else setError('Could not change password. Try again.')
        setBusy(false)
        return
      }
      // change-password kills the session — send the user back to /login.
      router.replace('/login')
    } catch {
      setError('Network error. Try again.')
      setBusy(false)
    }
  }

  return (
    <div className="max-w-sm mx-auto space-y-6">
      <h1 className="text-2xl font-semibold">Change password</h1>
      <p className="text-sm text-zinc-400">
        Set a new password before you can use the dashboard. Minimum 12 characters.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="text-sm text-zinc-400">Current password</span>
          <input type="password" autoComplete="current-password" required value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-500" />
        </label>
        <label className="block">
          <span className="text-sm text-zinc-400">New password</span>
          <input type="password" autoComplete="new-password" required value={next}
            onChange={(e) => setNext(e.target.value)}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-500" />
        </label>
        <label className="block">
          <span className="text-sm text-zinc-400">Confirm new password</span>
          <input type="password" autoComplete="new-password" required value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-500" />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button type="submit" disabled={busy}
          className="w-full rounded bg-zinc-100 px-3 py-2 font-medium text-zinc-900 disabled:opacity-50 hover:bg-white">
          {busy ? 'Saving…' : 'Save new password'}
        </button>
      </form>
    </div>
  )
}
