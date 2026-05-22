'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'

export interface FeedSummary {
  id: string
  label: string
  url: string
  enabled: boolean
  poll_interval_s: number
  last_polled_at: string | null
  last_success_at: string | null
  last_error: string | null
  consecutive_failures: number
  backfill_mode: string
}

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

export function FeedRow({ feed }: { feed: FeedSummary }) {
  const router = useRouter()

  async function remove() {
    if (!confirm(`Delete feed "${feed.label}"? Routes, items, and dispatch history will also be removed.`)) return
    const res = await fetch(`/api/feeds/${feed.id}`, { method: 'DELETE' })
    if (res.ok) router.refresh()
    else alert('Delete failed')
  }

  return (
    <li className="rounded border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{feed.label}</span>
            {!feed.enabled && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">disabled</span>}
            {feed.backfill_mode !== 'none' && feed.backfill_mode !== 'done' && (
              <span className="rounded bg-blue-900 px-1.5 py-0.5 text-xs text-blue-200">backfill pending</span>
            )}
            {feed.consecutive_failures > 0 && (
              <span className="rounded bg-red-900 px-1.5 py-0.5 text-xs text-red-200">{feed.consecutive_failures} failures</span>
            )}
          </div>
          <div className="mt-1 truncate text-xs text-zinc-500">{feed.url}</div>
          <div className="mt-1 text-xs text-zinc-500">
            polls every {Math.round(feed.poll_interval_s / 60)} min
            {' · '}last polled {ago(feed.last_polled_at)}
            {feed.last_success_at && ` · last ok ${ago(feed.last_success_at)}`}
          </div>
          {feed.last_error && (
            <div className="mt-1 text-xs text-red-400">last error: {feed.last_error}</div>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Link href={`/dashboard/feeds/${feed.id}`} className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800">
            Edit
          </Link>
          <button onClick={remove} className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950">
            Delete
          </button>
        </div>
      </div>
    </li>
  )
}
