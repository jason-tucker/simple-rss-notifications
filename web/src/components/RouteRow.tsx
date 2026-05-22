'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

export interface RouteSummary {
  id: string
  feed_id: string
  sink_type: string
  sink_id: string
  destination: string
  label: string | null
  enabled: boolean
  feed_label: string
  feed_url: string
}

export function RouteRow({ route }: { route: RouteSummary }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function toggle() {
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
    if (!confirm(`Delete this route? Dispatch history will be removed.`)) return
    const res = await fetch(`/api/routes/${route.id}`, { method: 'DELETE' })
    if (res.ok) router.refresh()
    else alert('Delete failed')
  }

  return (
    <li className="rounded border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{route.label ?? route.feed_label}</span>
            {!route.enabled && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">disabled</span>}
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs uppercase text-zinc-400">{route.sink_type}</span>
          </div>
          <div className="mt-1 text-xs text-zinc-500">
            <span className="text-zinc-400">{route.feed_label}</span>
            <span className="mx-2">→</span>
            <span className="text-zinc-400">{route.destination}</span>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button onClick={toggle} disabled={busy} className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-40">
            {route.enabled ? 'Disable' : 'Enable'}
          </button>
          <button onClick={remove} className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950">
            Delete
          </button>
        </div>
      </div>
    </li>
  )
}
