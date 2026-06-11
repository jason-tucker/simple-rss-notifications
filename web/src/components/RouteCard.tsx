'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Badge, Button, ButtonLink, Card } from '@/components/ui'
import { sinkTypeBadge } from '@/lib/format'

export interface RouteCardData {
  id: string
  feed_id: string
  label: string | null
  enabled: boolean
  feed_label: string
  feed_url: string
  destinations: Array<{
    id: string
    sink_type: string
    sink_id: string
    destination: string | null
    enabled: boolean
    sink_label: string | null
  }>
}

export function RouteCard({ route }: { route: RouteCardData }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function toggleRoute() {
    setBusy(true)
    const res = await fetch(`/api/routes/${route.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !route.enabled }),
    })
    setBusy(false)
    if (res.ok) router.refresh()
    else alert('Update failed')
  }

  async function remove() {
    if (!confirm(`Delete this route and all its destinations? Dispatch history will be removed.`)) return
    const res = await fetch(`/api/routes/${route.id}`, { method: 'DELETE' })
    if (res.ok) router.refresh()
    else alert('Delete failed')
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-zinc-100">{route.label ?? route.feed_label}</span>
            {!route.enabled && <Badge>paused</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            watches <span className="text-zinc-300">{route.feed_label}</span>
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <ButtonLink size="sm" href={`/dashboard/routes/${route.id}`}>Edit</ButtonLink>
          <Button size="sm" onClick={toggleRoute} disabled={busy}>
            {route.enabled ? 'Pause' : 'Resume'}
          </Button>
          <Button size="sm" variant="danger" onClick={remove}>Delete</Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {route.destinations.length === 0 && (
          <span className="text-xs text-amber-400">no destinations — items won&apos;t be sent anywhere</span>
        )}
        {route.destinations.map((d) => (
          <span
            key={d.id}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
              d.enabled ? 'border-zinc-700 bg-zinc-950 text-zinc-300' : 'border-zinc-800 bg-zinc-950 text-zinc-600 line-through'
            }`}
          >
            <span className="text-zinc-500">{sinkTypeBadge(d.sink_type)}</span>
            <span>{d.sink_label ?? '(deleted sink)'}</span>
            {d.destination && <span className="text-zinc-500">→ {d.destination}</span>}
          </span>
        ))}
      </div>
    </Card>
  )
}
