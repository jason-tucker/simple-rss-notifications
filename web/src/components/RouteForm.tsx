'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface FeedOption {
  id: string
  label: string
  enabled: boolean
}
export interface SinkOption {
  id: string
  label: string
  incomplete: boolean
  type: 'smtp' | 'resend' | 'ntfy' | 'discord_webhook'
  topic: string | null
}

interface DestinationDraft {
  /** Local-only id for keying React lists; not sent to the server. */
  key: string
  sinkKey: string // `${type}:${id}`
  destination: string
}

const EMAIL_TYPES = ['smtp', 'resend'] as const
const isEmailType = (t: string) => (EMAIL_TYPES as readonly string[]).includes(t)

function newKey() { return Math.random().toString(36).slice(2, 10) }

interface NewProps {
  mode: 'new'
  feeds: FeedOption[]
  sinks: SinkOption[]
}

export function RouteForm({ feeds, sinks }: NewProps) {
  const router = useRouter()
  const [feedId, setFeedId] = useState(feeds[0]?.id ?? '')
  const [label, setLabel] = useState('')
  const [destinations, setDestinations] = useState<DestinationDraft[]>([
    { key: newKey(), sinkKey: sinks[0] ? `${sinks[0].type}:${sinks[0].id}` : '', destination: '' },
  ])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function addDestination() {
    setDestinations((d) => [...d, { key: newKey(), sinkKey: sinks[0] ? `${sinks[0].type}:${sinks[0].id}` : '', destination: '' }])
  }
  function removeDestination(key: string) {
    setDestinations((d) => d.length === 1 ? d : d.filter((x) => x.key !== key))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const dests = destinations.map((d) => {
        const [sink_type, sink_id] = d.sinkKey.split(':')
        return {
          sink_type,
          sink_id,
          destination: isEmailType(sink_type) ? d.destination : null,
          enabled: true,
        }
      })
      const res = await fetch('/api/routes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          feed_id: feedId,
          label: label.trim() || null,
          enabled: true,
          destinations: dests,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: Array<{ message: string }> }
        const firstIssue = body.issues?.[0]?.message
        setError(firstIssue ?? body.error ?? `Save failed (${res.status})`)
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
    <form onSubmit={submit} className="space-y-4">
      <label className="block">
        <span className="text-sm text-zinc-400">Source feed</span>
        <select required value={feedId} onChange={(e) => setFeedId(e.target.value)} className={inputCls}>
          {feeds.map((f) => (
            <option key={f.id} value={f.id} disabled={!f.enabled}>
              {f.label}{!f.enabled ? ' (disabled)' : ''}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-sm text-zinc-400">Label <span className="text-zinc-600">(optional)</span></span>
        <input maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls} placeholder="e.g. UniFi → home everywhere" />
      </label>

      <fieldset className="rounded border border-zinc-800 p-3 space-y-3">
        <legend className="px-2 text-xs uppercase tracking-wide text-zinc-500">Destinations</legend>
        {destinations.map((d) => {
          const [type] = d.sinkKey.split(':')
          const needsEmail = isEmailType(type)
          return (
            <div key={d.key} className="space-y-2 rounded border border-zinc-800 p-2">
              <div className="flex gap-2">
                <select
                  value={d.sinkKey}
                  onChange={(e) => setDestinations((arr) => arr.map((x) => x.key === d.key ? { ...x, sinkKey: e.target.value } : x))}
                  className={inputCls}
                >
                  {sinks.map((s) => (
                    <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`} disabled={s.incomplete}>
                      [{s.type.replace('_webhook', '').toUpperCase()}] {s.label}{s.incomplete ? ' (incomplete)' : ''}
                    </option>
                  ))}
                </select>
                {destinations.length > 1 && (
                  <button type="button" onClick={() => removeDestination(d.key)} className="rounded border border-red-900 px-2 text-xs text-red-300 hover:bg-red-950">
                    Remove
                  </button>
                )}
              </div>
              {needsEmail ? (
                <input
                  required
                  type="email"
                  value={d.destination}
                  onChange={(e) => setDestinations((arr) => arr.map((x) => x.key === d.key ? { ...x, destination: e.target.value } : x))}
                  className={inputCls}
                  placeholder="destination email — e.g. tucker@itsupportri.com"
                />
              ) : (
                <p className="text-xs text-zinc-500 px-1">
                  Delivers to the sink&apos;s configured target ({type === 'ntfy' ? 'topic' : 'webhook'}). No per-route address needed.
                </p>
              )}
            </div>
          )
        })}
        <button type="button" onClick={addDestination} className="rounded border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800">
          + Add destination
        </button>
      </fieldset>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex gap-2 pt-2">
        <button type="submit" disabled={busy} className="rounded bg-zinc-100 px-4 py-2 font-medium text-zinc-900 hover:bg-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Create route'}
        </button>
      </div>
    </form>
  )
}
