'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, CheckboxRow, Field, Input } from '@/components/ui'

interface Initial {
  id: string
  label: string
  url: string
  enabled: boolean
  poll_interval_s: number
}

export function EditFeedForm({ initial }: { initial: Initial }) {
  const router = useRouter()
  const [label, setLabel] = useState(initial.label)
  const [url, setUrl] = useState(initial.url)
  const [enabled, setEnabled] = useState(initial.enabled)
  const [pollMinutes, setPollMinutes] = useState(String(Math.round(initial.poll_interval_s / 60)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(`/api/feeds/${initial.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label,
          url,
          enabled,
          poll_interval_s: Math.max(60, Number(pollMinutes) * 60),
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `Save failed (${res.status})`)
        setBusy(false)
        return
      }
      router.replace('/dashboard/feeds')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Name">
        <Input required maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field label="RSS URL" hint="Changing the URL resets the HTTP cache hints (etag / last-modified).">
        <Input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label="Check every (minutes)">
        <Input required type="number" min={1} max={1440} value={pollMinutes} onChange={(e) => setPollMinutes(e.target.value)} />
      </Field>
      <CheckboxRow label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? 'Saving…' : 'Save changes'}
      </Button>
    </form>
  )
}
