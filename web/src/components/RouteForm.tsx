'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Card, Field, Input, Select } from '@/components/ui'
import { sinkTypeBadge } from '@/lib/format'

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
  // Default to the first usable sink — incomplete ones are disabled in the
  // dropdown, so they must not be the initial selection either.
  const defaultSink = sinks.find((s) => !s.incomplete) ?? sinks[0]
  const defaultSinkKey = defaultSink ? `${defaultSink.type}:${defaultSink.id}` : ''
  const [feedId, setFeedId] = useState(feeds[0]?.id ?? '')
  const [label, setLabel] = useState('')
  const [destinations, setDestinations] = useState<DestinationDraft[]>([
    { key: newKey(), sinkKey: defaultSinkKey, destination: '' },
  ])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function addDestination() {
    setDestinations((d) => [...d, { key: newKey(), sinkKey: defaultSinkKey, destination: '' }])
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

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Watch this feed">
        <Select required value={feedId} onChange={(e) => setFeedId(e.target.value)}>
          {feeds.map((f) => (
            <option key={f.id} value={f.id} disabled={!f.enabled}>
              {f.label}{!f.enabled ? ' (paused)' : ''}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Name" optional hint="Defaults to the feed's name if left blank.">
        <Input maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. UniFi → home everywhere" />
      </Field>

      <Card className="space-y-3 p-4">
        <p className="text-sm font-medium text-zinc-300">Send new items to</p>
        {destinations.map((d) => {
          const [type] = d.sinkKey.split(':')
          const needsEmail = isEmailType(type)
          return (
            <div key={d.key} className="space-y-2 rounded-md border border-zinc-800 p-3">
              <div className="flex gap-2">
                <Select
                  value={d.sinkKey}
                  onChange={(e) => setDestinations((arr) => arr.map((x) => x.key === d.key ? { ...x, sinkKey: e.target.value } : x))}
                >
                  {sinks.map((s) => (
                    <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`} disabled={s.incomplete}>
                      [{sinkTypeBadge(s.type)}] {s.label}{s.incomplete ? ' (incomplete)' : ''}
                    </option>
                  ))}
                </Select>
                {destinations.length > 1 && (
                  <Button size="sm" variant="danger" onClick={() => removeDestination(d.key)}>
                    Remove
                  </Button>
                )}
              </div>
              {needsEmail ? (
                <Input
                  required
                  type="email"
                  value={d.destination}
                  onChange={(e) => setDestinations((arr) => arr.map((x) => x.key === d.key ? { ...x, destination: e.target.value } : x))}
                  placeholder="recipient email — e.g. you@example.com"
                />
              ) : (
                <p className="px-1 text-xs text-zinc-500">
                  Delivers to the sink&apos;s configured target ({type === 'ntfy' ? 'topic' : 'webhook'}). Nothing else to fill in.
                </p>
              )}
            </div>
          )
        })}
        <Button size="sm" onClick={addDestination}>+ Add another destination</Button>
      </Card>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? 'Saving…' : 'Create route'}
      </Button>
    </form>
  )
}
