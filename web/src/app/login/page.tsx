'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const next = params.get('next') ?? '/'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string; retryAfterSec?: number }
        if (res.status === 429) {
          setError(`Too many attempts. Try again in ${body.retryAfterSec ?? 60}s.`)
        } else if (body.code === 'invalid-credentials') {
          setError('Wrong username or password.')
        } else {
          setError('Login failed. Check your credentials and try again.')
        }
        setBusy(false)
        return
      }
      const data = (await res.json()) as { must_change_password: boolean }
      router.replace(data.must_change_password ? '/account/password' : next)
    } catch {
      setError('Network error. Try again.')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="text-sm text-zinc-400">Username</span>
        <input
          type="text"
          autoComplete="username"
          required
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-500"
        />
      </label>
      <label className="block">
        <span className="text-sm text-zinc-400">Password</span>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-500"
        />
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded bg-zinc-100 px-3 py-2 font-medium text-zinc-900 disabled:opacity-50 hover:bg-white"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}

export default function LoginPage() {
  return (
    <div className="max-w-sm mx-auto space-y-6">
      <h1 className="text-2xl font-semibold">Log in</h1>
      {/* Suspense required around useSearchParams() in Next 15 so prerender doesn't bail. */}
      <Suspense fallback={<div className="text-sm text-zinc-500">Loading…</div>}>
        <LoginForm />
      </Suspense>
    </div>
  )
}
