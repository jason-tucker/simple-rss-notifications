'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

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

  const inputCls = 'mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-500'

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="text-sm text-zinc-400">Label</span>
        <input required maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls} />
      </label>
      <label className="block">
        <span className="text-sm text-zinc-400">RSS URL</span>
        <input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} className={inputCls} />
        <span className="mt-1 block text-xs text-zinc-500">Changing the URL resets the HTTP cache hints (etag / last-modified).</span>
      </label>
      <label className="block">
        <span className="text-sm text-zinc-400">Poll interval (minutes)</span>
        <input required type="number" min={1} max={1440} value={pollMinutes} onChange={(e) => setPollMinutes(e.target.value)} className={inputCls} />
      </label>
      <label className="flex items-center gap-2 text-sm text-zinc-400">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2 pt-2">
        <button type="submit" disabled={busy} className="rounded bg-zinc-100 px-4 py-2 font-medium text-zinc-900 hover:bg-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  )
}
