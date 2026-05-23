'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Route {
  id: string
  feed_id: string
  label: string | null
  enabled: boolean
  feed_label: string
}
interface Destination {
  id: string
  sink_type: string
  sink_id: string
  destination: string | null
  enabled: boolean
  sink_label: string | null
}
interface SinkOption {
  id: string
  label: string
  incomplete: boolean
  type: 'smtp' | 'resend' | 'ntfy' | 'discord_webhook'
}

const EMAIL_TYPES = ['smtp', 'resend']

export function EditRouteForm({ route, destinations, sinks }: { route: Route; destinations: Destination[]; sinks: SinkOption[] }) {
  const router = useRouter()
  const [label, setLabel] = useState(route.label ?? '')
  const [busy, setBusy] = useState(false)

  async function saveLabel() {
    setBusy(true)
    await fetch(`/api/routes/${route.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: label.trim() || null }),
    })
    setBusy(false)
    router.refresh()
  }

  const inputCls = 'mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-500'

  return (
    <div className="space-y-6">
      <section className="space-y-2 rounded border border-zinc-800 bg-zinc-900 p-3">
        <p className="text-xs text-zinc-500">
          Source feed: <span className="text-zinc-300">{route.feed_label}</span>
          {' '}<span className="text-zinc-600">(change by deleting and recreating the route)</span>
        </p>
        <label className="block">
          <span className="text-sm text-zinc-400">Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} className={inputCls} />
        </label>
        <div className="flex justify-end">
          <button onClick={saveLabel} disabled={busy} className="rounded bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50">
            {busy ? 'Saving…' : 'Save label'}
          </button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Destinations</h2>
        <ul className="space-y-2">
          {destinations.map((d) => (
            <DestinationRow key={d.id} routeId={route.id} dest={d} />
          ))}
          {destinations.length === 0 && (
            <li className="rounded border border-amber-700 bg-amber-950 p-3 text-sm text-amber-200">
              This route has no destinations. New feed items won&apos;t be sent anywhere.
            </li>
          )}
        </ul>
        <AddDestination routeId={route.id} sinks={sinks} />
      </section>
    </div>
  )
}

function DestinationRow({ routeId, dest }: { routeId: string; dest: Destination }) {
  const router = useRouter()
  const [destination, setDestination] = useState(dest.destination ?? '')
  const [enabled, setEnabled] = useState(dest.enabled)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const needsEmail = EMAIL_TYPES.includes(dest.sink_type)
  const inputCls = 'rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-zinc-500'

  async function save() {
    setBusy(true)
    await fetch(`/api/routes/${routeId}/destinations/${dest.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        destination: needsEmail ? destination : null,
        enabled,
      }),
    })
    setBusy(false)
    router.refresh()
  }

  async function remove() {
    if (!confirm('Remove this destination from the route?')) return
    setBusy(true)
    await fetch(`/api/routes/${routeId}/destinations/${dest.id}`, { method: 'DELETE' })
    setBusy(false)
    router.refresh()
  }

  async function sendLatest() {
    setTesting(true)
    setTestMsg(null)
    try {
      const res = await fetch(`/api/routes/${routeId}/destinations/${dest.id}/test-with-latest`, { method: 'POST' })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; code?: string; retryAfterSec?: number
        item?: { id: string; title: string | null }
      }
      if (res.ok && body.ok) {
        const title = body.item?.title ? `"${body.item.title}"` : 'latest item'
        setTestMsg({ ok: true, text: `Sent ${title}` })
      } else if (res.status === 429) {
        setTestMsg({ ok: false, text: `Rate-limited (${body.retryAfterSec ?? 60}s)` })
      } else if (body.code === 'no-items') {
        setTestMsg({ ok: false, text: 'Feed has no items yet — wait for the first poll' })
      } else if (body.code === 'missing-destination') {
        setTestMsg({ ok: false, text: 'Set a destination email first, then Save' })
      } else {
        setTestMsg({ ok: false, text: `${body.code ?? res.status} — ${body.error ?? 'send failed'}` })
      }
    } catch (err) {
      setTestMsg({ ok: false, text: err instanceof Error ? err.message : 'network error' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <li className="rounded border border-zinc-800 bg-zinc-900 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs uppercase text-zinc-400">
          {dest.sink_type.replace('_webhook', '')}
        </span>
        <span className="text-sm text-zinc-300">{dest.sink_label ?? '(deleted sink)'}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {needsEmail ? (
          <input
            type="email"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="destination email"
            className={`${inputCls} flex-1 min-w-[14rem]`}
          />
        ) : (
          <span className="text-xs text-zinc-500 flex-1">delivers to the sink&apos;s configured target</span>
        )}
        <label className="flex items-center gap-1 text-xs text-zinc-400">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          enabled
        </label>
        <button onClick={save} disabled={busy} className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-40">
          Save
        </button>
        <button
          onClick={sendLatest}
          disabled={busy || testing}
          title="Send the most recent feed item through this destination — does not record in dispatch history."
          className="rounded border border-emerald-800 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-950 disabled:opacity-40"
        >
          {testing ? 'Sending…' : 'Send latest'}
        </button>
        <button onClick={remove} disabled={busy} className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950 disabled:opacity-40">
          Remove
        </button>
      </div>
      {testMsg && (
        <p className={`text-xs ${testMsg.ok ? 'text-emerald-300' : 'text-red-400'}`}>{testMsg.text}</p>
      )}
    </li>
  )
}

function AddDestination({ routeId, sinks }: { routeId: string; sinks: SinkOption[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [sinkKey, setSinkKey] = useState(sinks[0] ? `${sinks[0].type}:${sinks[0].id}` : '')
  const [destination, setDestination] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [type] = sinkKey.split(':')
  const needsEmail = EMAIL_TYPES.includes(type)
  const inputCls = 'rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-zinc-500'

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800">
        + Add destination
      </button>
    )
  }

  async function add() {
    setError(null)
    setBusy(true)
    try {
      const [sink_type, sink_id] = sinkKey.split(':')
      const res = await fetch(`/api/routes/${routeId}/destinations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sink_type,
          sink_id,
          destination: needsEmail ? destination : null,
          enabled: true,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: Array<{ message: string }> }
        setError(body.issues?.[0]?.message ?? body.error ?? `Save failed (${res.status})`)
        setBusy(false)
        return
      }
      setOpen(false)
      setDestination('')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
      setBusy(false)
    }
  }

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-3 space-y-2">
      <select value={sinkKey} onChange={(e) => setSinkKey(e.target.value)} className={`${inputCls} w-full`}>
        {sinks.map((s) => (
          <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`} disabled={s.incomplete}>
            [{s.type.replace('_webhook', '').toUpperCase()}] {s.label}{s.incomplete ? ' (incomplete)' : ''}
          </option>
        ))}
      </select>
      {needsEmail && (
        <input
          required
          type="email"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="destination email"
          className={`${inputCls} w-full`}
        />
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2 justify-end">
        <button onClick={() => setOpen(false)} disabled={busy} className="rounded border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800 disabled:opacity-40">
          Cancel
        </button>
        <button onClick={add} disabled={busy} className="rounded bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50">
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
    </div>
  )
}
