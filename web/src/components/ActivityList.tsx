'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { isSafeHttpUrl } from '@/lib/url'

export interface ActivityRow {
  id: string
  status: 'pending' | 'sent' | 'failed' | 'skipped' | string
  attempts: number
  scheduled_at: string
  dispatched_at: string | null
  error: string | null
  provider_message_id: string | null
  created_at: string
  route_id: string
  route_label: string | null
  feed_id: string
  feed_label: string
  item_title: string | null
  item_link: string | null
  sink_type: string
  sink_id: string
  destination: string | null
  sink_label: string | null
}

function ago(iso: string | null): string {
  if (!iso) return '—'
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (sec < 0) return `in ${Math.abs(sec)}s`
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

function statusClass(status: string): string {
  switch (status) {
    case 'sent':    return 'border-emerald-800 bg-emerald-950 text-emerald-300'
    case 'failed':  return 'border-red-900 bg-red-950 text-red-300'
    case 'pending': return 'border-amber-800 bg-amber-950 text-amber-200'
    case 'skipped': return 'border-zinc-700 bg-zinc-900 text-zinc-400'
    default:        return 'border-zinc-700 bg-zinc-900 text-zinc-400'
  }
}

export function ActivityList({ rows, total }: { rows: ActivityRow[]; total: number }) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-500">
        No dispatches match the current filter. Add a feed + route, then come back here in a minute or two.
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500">Showing {rows.length} of {total}.</p>
      <ul className="space-y-2">
        {rows.map((r) => <ActivityItem key={r.id} row={r} />)}
      </ul>
    </div>
  )
}

function ActivityItem({ row }: { row: ActivityRow }) {
  const router = useRouter()
  const [retryBusy, setRetryBusy] = useState(false)
  const [retryMsg, setRetryMsg] = useState<string | null>(null)

  async function retry() {
    setRetryBusy(true)
    setRetryMsg(null)
    try {
      const res = await fetch(`/api/dispatches/${row.id}/retry`, { method: 'POST' })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string; retryAfterSec?: number }
      if (res.ok && body.ok) {
        setRetryMsg('Queued')
        router.refresh()
      } else if (res.status === 429) {
        setRetryMsg(`Rate-limited (${body.retryAfterSec ?? 60}s)`)
      } else {
        setRetryMsg(body.code ?? body.error ?? `error ${res.status}`)
      }
    } catch (err) {
      setRetryMsg(err instanceof Error ? err.message : 'network error')
    } finally {
      setRetryBusy(false)
    }
  }

  return (
    <li className="rounded border border-zinc-800 bg-zinc-900 p-3 space-y-2">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`rounded border px-1.5 py-0.5 text-xs uppercase ${statusClass(row.status)}`}>
              {row.status}
            </span>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs uppercase text-zinc-400">
              {row.sink_type.replace('_webhook', '')}
            </span>
            <span className="text-sm text-zinc-300 truncate">{row.item_title ?? '(no title)'}</span>
          </div>
          <div className="mt-1 text-xs text-zinc-500 truncate">
            <span className="text-zinc-400">{row.feed_label}</span>
            <span className="mx-1.5">→</span>
            <span className="text-zinc-400">{row.sink_label ?? '(deleted)'}</span>
            {row.destination && <span className="text-zinc-500"> · {row.destination}</span>}
          </div>
          <div className="mt-1 text-xs text-zinc-600">
            attempt #{row.attempts}
            {' · scheduled '}{ago(row.scheduled_at)}
            {row.dispatched_at && <>{' · last try '}{ago(row.dispatched_at)}</>}
          </div>
          {row.error && (
            <pre className="mt-2 max-w-full overflow-x-auto rounded bg-zinc-950 p-2 text-xs text-red-300 whitespace-pre-wrap break-words">{row.error}</pre>
          )}
        </div>
        <div className="flex shrink-0 gap-2 items-center">
          {/*
            Only render the "Source" anchor when the feed-controlled link is
            an http(s) URL. RSS feeds are attacker-controlled, and React does
            NOT strip dangerous href schemes (e.g. `javascript:`), so an
            unguarded href here is a stored-XSS sink. Unsafe links are dropped
            (the item title is still shown as plain text above). Ingest in
            lib/rss/parse.ts also blanks non-http(s) links as defense-in-depth.
          */}
          {row.item_link && isSafeHttpUrl(row.item_link) && (
            <a href={row.item_link} target="_blank" rel="noopener noreferrer" className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
              Source ↗
            </a>
          )}
          {row.status === 'failed' && (
            <>
              <button onClick={retry} disabled={retryBusy} className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-40">
                {retryBusy ? 'Retrying…' : 'Retry'}
              </button>
              {retryMsg && <span className="text-xs text-zinc-400">{retryMsg}</span>}
            </>
          )}
        </div>
      </div>
    </li>
  )
}
