'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface FeedOption {
  id: string
  label: string
  enabled: boolean
}
interface SinkOption {
  id: string
  label: string
  incomplete: boolean
  type: 'smtp' | 'resend'
}

export function NewRouteForm({ feeds, sinks }: { feeds: FeedOption[]; sinks: SinkOption[] }) {
  const router = useRouter()
  const [feedId, setFeedId] = useState(feeds[0]?.id ?? '')
  const [sinkKey, setSinkKey] = useState(sinks[0] ? `${sinks[0].type}:${sinks[0].id}` : '')
  const [destination, setDestination] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const [sinkType, sinkId] = sinkKey.split(':')
      const res = await fetch('/api/routes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          feed_id: feedId,
          sink_type: sinkType,
          sink_id: sinkId,
          destination,
          label: label.trim() || null,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `Save failed (${res.status})`)
        setBusy(false)
        return
      }
      router.replace('/dashboard/routes')
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
        <span className="text-sm text-zinc-400">Feed</span>
        <select required value={feedId} onChange={(e) => setFeedId(e.target.value)} className={inputCls}>
          {feeds.map((f) => (
            <option key={f.id} value={f.id} disabled={!f.enabled}>
              {f.label}{!f.enabled ? ' (disabled)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-sm text-zinc-400">Sink</span>
        <select required value={sinkKey} onChange={(e) => setSinkKey(e.target.value)} className={inputCls}>
          {sinks.map((s) => (
            <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`} disabled={s.incomplete}>
              [{s.type.toUpperCase()}] {s.label}{s.incomplete ? ' (incomplete)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-sm text-zinc-400">Destination email</span>
        <input required type="email" value={destination} onChange={(e) => setDestination(e.target.value)} className={inputCls} placeholder="tucker@itsupportri.com" />
      </label>
      <label className="block">
        <span className="text-sm text-zinc-400">Label <span className="text-zinc-600">(optional)</span></span>
        <input maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls} placeholder="e.g. UniFi → me" />
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2 pt-2">
        <button type="submit" disabled={busy} className="rounded bg-zinc-100 px-4 py-2 font-medium text-zinc-900 hover:bg-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Create route'}
        </button>
      </div>
    </form>
  )
}
