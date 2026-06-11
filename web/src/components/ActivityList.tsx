'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { isSafeHttpUrl } from '@/lib/url'
import { Badge, Button, Card, EmptyState, type BadgeTone } from '@/components/ui'
import { sinkTypeBadge, timeAgo } from '@/lib/format'

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

function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'sent': return 'ok'
    case 'failed': return 'danger'
    case 'pending': return 'warn'
    default: return 'neutral'
  }
}

export function ActivityList({ rows, total }: { rows: ActivityRow[]; total: number }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing here yet"
        hint="No notifications match the current filter. Add a feed and a route, then check back in a minute or two."
      />
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
    <li>
      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Badge tone={statusTone(row.status)} className="uppercase">{row.status}</Badge>
              <Badge>{sinkTypeBadge(row.sink_type)}</Badge>
              <span className="truncate text-sm text-zinc-300">{row.item_title ?? '(no title)'}</span>
            </div>
            <div className="mt-1 truncate text-xs text-zinc-500">
              <span className="text-zinc-400">{row.feed_label}</span>
              <span className="mx-1.5">→</span>
              <span className="text-zinc-400">{row.sink_label ?? '(deleted)'}</span>
              {row.destination && <span className="text-zinc-500"> · {row.destination}</span>}
            </div>
            <div className="mt-1 text-xs text-zinc-600">
              attempt #{row.attempts}
              {' · scheduled '}{timeAgo(row.scheduled_at)}
              {row.dispatched_at && <>{' · last try '}{timeAgo(row.dispatched_at)}</>}
            </div>
            {row.error && (
              <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-2 text-xs text-red-300">{row.error}</pre>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/*
              Only render the "Source" anchor when the feed-controlled link is
              an http(s) URL. RSS feeds are attacker-controlled, and React does
              NOT strip dangerous href schemes (e.g. `javascript:`), so an
              unguarded href here is a stored-XSS sink. Unsafe links are dropped
              (the item title is still shown as plain text above). Ingest in
              lib/rss/parse.ts also blanks non-http(s) links as defense-in-depth.
            */}
            {row.item_link && isSafeHttpUrl(row.item_link) && (
              <a
                href={row.item_link}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Source ↗
              </a>
            )}
            {row.status === 'failed' && (
              <>
                <Button size="sm" onClick={retry} disabled={retryBusy}>
                  {retryBusy ? 'Retrying…' : 'Retry'}
                </Button>
                {retryMsg && <span className="text-xs text-zinc-400">{retryMsg}</span>}
              </>
            )}
          </div>
        </div>
      </Card>
    </li>
  )
}
