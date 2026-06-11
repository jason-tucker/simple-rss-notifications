'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Badge, Button, Card, CheckboxRow, Field, Input, Select } from '@/components/ui'
import { sinkTypeBadge } from '@/lib/format'

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

  return (
    <div className="space-y-6">
      <Card className="space-y-3 p-4">
        <p className="text-xs text-zinc-500">
          Watches <span className="text-zinc-300">{route.feed_label}</span>
          {' '}<span className="text-zinc-600">(to watch a different feed, delete this route and create a new one)</span>
        </p>
        <Field label="Name">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} />
        </Field>
        <div className="flex justify-end">
          <Button size="sm" variant="primary" onClick={saveLabel} disabled={busy}>
            {busy ? 'Saving…' : 'Save name'}
          </Button>
        </div>
      </Card>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-zinc-100">Destinations</h2>
        <ul className="space-y-2">
          {destinations.map((d) => (
            <DestinationRow key={d.id} routeId={route.id} dest={d} />
          ))}
          {destinations.length === 0 && (
            <li className="rounded-lg border border-amber-900 bg-amber-950/60 p-4 text-sm text-amber-200">
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
        setTestMsg({ ok: false, text: 'Feed has no items yet — wait for the first check' })
      } else if (body.code === 'missing-destination') {
        setTestMsg({ ok: false, text: 'Set a recipient email first, then Save' })
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
    <li>
      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{sinkTypeBadge(dest.sink_type)}</Badge>
          <span className="text-sm text-zinc-300">{dest.sink_label ?? '(deleted sink)'}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {needsEmail ? (
            <Input
              type="email"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="recipient email"
              className="min-w-[14rem] flex-1"
            />
          ) : (
            <span className="flex-1 text-xs text-zinc-500">delivers to the sink&apos;s configured target</span>
          )}
          <CheckboxRow label="enabled" className="text-xs" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <Button size="sm" onClick={save} disabled={busy}>Save</Button>
          <Button
            size="sm"
            onClick={sendLatest}
            disabled={busy || testing}
            title="Send the most recent feed item through this destination — does not record in dispatch history."
            className="border-emerald-800 text-emerald-300 hover:bg-emerald-950"
          >
            {testing ? 'Sending…' : 'Send latest'}
          </Button>
          <Button size="sm" variant="danger" onClick={remove} disabled={busy}>Remove</Button>
        </div>
        {testMsg && (
          <p className={`text-xs ${testMsg.ok ? 'text-emerald-300' : 'text-red-400'}`}>{testMsg.text}</p>
        )}
      </Card>
    </li>
  )
}

function AddDestination({ routeId, sinks }: { routeId: string; sinks: SinkOption[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  // Default to the first usable sink — incomplete ones are disabled options.
  const defaultSink = sinks.find((s) => !s.incomplete) ?? sinks[0]
  const [sinkKey, setSinkKey] = useState(defaultSink ? `${defaultSink.type}:${defaultSink.id}` : '')
  const [destination, setDestination] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [type] = sinkKey.split(':')
  const needsEmail = EMAIL_TYPES.includes(type)

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>+ Add destination</Button>
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
    <Card className="space-y-2 p-4">
      <Select value={sinkKey} onChange={(e) => setSinkKey(e.target.value)}>
        {sinks.map((s) => (
          <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`} disabled={s.incomplete}>
            [{sinkTypeBadge(s.type)}] {s.label}{s.incomplete ? ' (incomplete)' : ''}
          </option>
        ))}
      </Select>
      {needsEmail && (
        <Input
          required
          type="email"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="recipient email"
        />
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
        <Button size="sm" variant="primary" onClick={add} disabled={busy}>
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </Card>
  )
}
