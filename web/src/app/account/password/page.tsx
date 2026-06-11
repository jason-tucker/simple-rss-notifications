'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Card, Field, Input } from '@/components/ui'

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
    if (next.length < 8) {
      setError('New password must be at least 8 characters.')
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
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold text-zinc-100">Change password</h1>
          <p className="text-sm text-zinc-400">
            Set a new password before you can use the dashboard. Minimum 8 characters.
          </p>
        </div>
        <Card className="p-5">
          <form onSubmit={submit} className="space-y-3">
            <Field label="Current password">
              <Input type="password" autoComplete="current-password" required value={current}
                onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field label="New password">
              <Input type="password" autoComplete="new-password" required value={next}
                onChange={(e) => setNext(e.target.value)} />
            </Field>
            <Field label="Confirm new password">
              <Input type="password" autoComplete="new-password" required value={confirm}
                onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <Button type="submit" variant="primary" disabled={busy} className="w-full">
              {busy ? 'Saving…' : 'Save new password'}
            </Button>
          </form>
        </Card>
      </div>
    </main>
  )
}
