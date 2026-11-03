'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Badge, Button, ButtonLink, Card, Dot } from '@/components/ui'
import { timeAgo } from '@/lib/format'
import { HookUrlReveal } from '@/components/HookUrlReveal'

export interface FeedSummary {
  id: string
  label: string
  kind: string
  url: string | null
  enabled: boolean
  poll_interval_s: number
  last_polled_at: string | null
  last_success_at: string | null
  last_error: string | null
  consecutive_failures: number
  backfill_mode: string
}

export function FeedRow({ feed }: { feed: FeedSummary }) {
  const router = useRouter()
  const isHook = feed.kind === 'webhook'
  const [newUrl, setNewUrl] = useState<string | null>(null)
  const [regenError, setRegenError] = useState<string | null>(null)

  async function remove() {
    if (!confirm(`Delete feed "${feed.label}"? Routes, items, and dispatch history will also be removed.`)) return
    const res = await fetch(`/api/feeds/${feed.id}`, { method: 'DELETE' })
    if (res.ok) router.refresh()
    else alert('Delete failed')
  }

  async function regenerate() {
    if (!confirm(`Regenerate the token for "${feed.label}"? The current webhook URL stops working immediately.`)) return
    setRegenError(null)
    const res = await fetch(`/api/feeds/${feed.id}/regenerate-token`, { method: 'POST' })
    if (!res.ok) { setRegenError('Regenerate failed'); return }
    const data = (await res.json()) as { hook_url?: string }
    setNewUrl(data.hook_url ?? null)
  }

  const health: 'ok' | 'danger' | 'off' = !feed.enabled ? 'off' : feed.consecutive_failures > 0 ? 'danger' : 'ok'

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Dot tone={health} />
            <span className="truncate font-medium text-zinc-100">{feed.label}</span>
            {isHook && <Badge tone="info">webhook</Badge>}
            {!feed.enabled && <Badge>paused</Badge>}
            {feed.backfill_mode !== 'none' && feed.backfill_mode !== 'done' && (
              <Badge tone="info">backfill pending</Badge>
            )}
            {feed.consecutive_failures > 0 && (
              <Badge tone="danger">{feed.consecutive_failures} failed poll{feed.consecutive_failures === 1 ? '' : 's'}</Badge>
            )}
          </div>
          {isHook ? (
            <div className="mt-1 text-xs text-zinc-500">
              Receives pushes at its private webhook URL (shown once at creation; regenerate to get a new one).
            </div>
          ) : (
          <>
          <div className="mt-1 truncate text-xs text-zinc-500">{feed.url}</div>
          <div className="mt-1 text-xs text-zinc-500">
            checks every {Math.round(feed.poll_interval_s / 60)} min
            {' · '}last checked {timeAgo(feed.last_polled_at)}
            {feed.last_success_at && ` · last ok ${timeAgo(feed.last_success_at)}`}
          </div>
          </>
          )}
          {feed.last_error && <div className="mt-1 break-words text-xs text-red-400">last error: {feed.last_error}</div>}
        </div>
        <div className="flex shrink-0 gap-2">
          {isHook && <Button size="sm" onClick={regenerate}>Regenerate token</Button>}
          <ButtonLink size="sm" href={`/dashboard/feeds/${feed.id}`}>Edit</ButtonLink>
          <Button size="sm" variant="danger" onClick={remove}>Delete</Button>
        </div>
      </div>
      {regenError && <p className="mt-2 text-xs text-red-400">{regenError}</p>}
      {newUrl && (
        <div className="mt-3 border-t border-zinc-800 pt-3">
          <HookUrlReveal url={newUrl} onDone={() => setNewUrl(null)} doneLabel="Hide" />
        </div>
      )}
    </Card>
  )
}
