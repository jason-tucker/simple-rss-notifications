'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

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
    <li className="rounded border border-zinc-800 bg-zinc-900 p-3 space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="truncate font-medium">{route.label ?? route.feed_label}</span>
            {!route.enabled && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">disabled</span>}
            <span className="text-xs text-zinc-500">from <span className="text-zinc-300">{route.feed_label}</span></span>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link href={`/dashboard/routes/${route.id}`} className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800">
            Edit
          </Link>
          <button onClick={toggleRoute} disabled={busy} className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-40">
            {route.enabled ? 'Disable' : 'Enable'}
          </button>
          <button onClick={remove} className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950">
            Delete
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {route.destinations.length === 0 && (
          <span className="text-xs text-amber-400">no destinations — items won&apos;t be sent anywhere</span>
        )}
        {route.destinations.map((d) => (
          <span key={d.id} className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs ${d.enabled ? 'border-zinc-700 bg-zinc-950 text-zinc-300' : 'border-zinc-800 bg-zinc-950 text-zinc-600 line-through'}`}>
            <span className="uppercase text-zinc-500">{d.sink_type.replace('_webhook', '')}</span>
            <span>{d.sink_label ?? '(deleted sink)'}</span>
            {d.destination && <span className="text-zinc-500">→ {d.destination}</span>}
          </span>
        ))}
      </div>
    </li>
  )
}
