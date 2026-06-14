'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Brand } from '@/components/Brand'
import { Button, Card, Field, Input } from '@/components/ui'

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
      <Field label="Username">
        <Input
          type="text"
          autoComplete="username"
          required
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </Field>
      <Field label="Password">
        <Input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <Button type="submit" variant="primary" disabled={busy} className="w-full">
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <Brand size={64} withWordmark={false} />
          <h1 className="text-2xl font-semibold">
            <span className="bg-gradient-to-r from-sky-400 via-violet-400 to-fuchsia-400 bg-clip-text text-transparent">Euphoric</span>
            <span className="text-zinc-100"> Notify</span>
          </h1>
          <p className="text-sm text-zinc-500">Sign in to manage your feeds and notifications.</p>
        </div>
        <Card className="p-5">
          {/* Suspense required around useSearchParams() in Next 15 so prerender doesn't bail. */}
          <Suspense fallback={<div className="text-sm text-zinc-500">Loading…</div>}>
            <LoginForm />
          </Suspense>
        </Card>
      </div>
    </main>
  )
}
