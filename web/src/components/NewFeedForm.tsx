'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Card, Field, Input } from '@/components/ui'

export function NewFeedForm() {
  const router = useRouter()
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [pollMinutes, setPollMinutes] = useState('15')
  const [backfillMode, setBackfillMode] = useState<'none' | 'count' | 'days'>('none')
  const [backfillValue, setBackfillValue] = useState('5')
  const [pacing, setPacing] = useState<'immediate' | 'spaced'>('immediate')
  const [paceSeconds, setPaceSeconds] = useState('60')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/feeds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label,
          url,
          poll_interval_s: Math.max(60, Number(pollMinutes) * 60),
          backfill_mode: backfillMode,
          backfill_value: backfillMode === 'none' ? 0 : Number(backfillValue),
          backfill_pace_seconds: pacing === 'spaced' ? Math.max(0, Number(paceSeconds)) : 0,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `Save failed (${res.status})`)
        setBusy(false)
        return
      }
      router.replace('/dashboard/feeds')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
      setBusy(false)
    }
  }

  const smallNumberCls = 'w-16 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-sm disabled:opacity-40'

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Name" hint="Anything that helps you recognize it.">
        <Input required maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. UniFi Security Advisories" />
      </Field>
      <Field label="RSS URL">
        <Input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/feed.xml" />
      </Field>
      <Field label="Check every (minutes)" hint="How often the worker re-checks this feed. Minimum 1 minute.">
        <Input required type="number" min={1} max={1440} value={pollMinutes} onChange={(e) => setPollMinutes(e.target.value)} />
      </Field>

      <Card className="space-y-3 p-4">
        <p className="text-sm font-medium text-zinc-300">Also send older items on the first check?</p>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="radio" name="bf" checked={backfillMode === 'none'} onChange={() => setBackfillMode('none')} />
            <span>No — only new items going forward</span>
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="radio" name="bf" checked={backfillMode === 'count'} onChange={() => setBackfillMode('count')} />
            <span>Send the last</span>
            <input type="number" min={1} max={500} value={backfillValue} onChange={(e) => setBackfillValue(e.target.value)} disabled={backfillMode !== 'count'} className={smallNumberCls} />
            <span>posts</span>
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="radio" name="bf" checked={backfillMode === 'days'} onChange={() => setBackfillMode('days')} />
            <span>Send items from the last</span>
            <input type="number" min={1} max={365} value={backfillValue} onChange={(e) => setBackfillValue(e.target.value)} disabled={backfillMode !== 'days'} className={smallNumberCls} />
            <span>days</span>
          </label>
        </div>

        {backfillMode !== 'none' && (
          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <span className="block text-xs text-zinc-500">Pacing</span>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="radio" name="pace" checked={pacing === 'immediate'} onChange={() => setPacing('immediate')} />
              <span>Send all at once</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="radio" name="pace" checked={pacing === 'spaced'} onChange={() => setPacing('spaced')} />
              <span>One every</span>
              <input type="number" min={1} max={3600} value={paceSeconds} onChange={(e) => setPaceSeconds(e.target.value)} disabled={pacing !== 'spaced'} className={`${smallNumberCls} w-20`} />
              <span>seconds</span>
            </label>
          </div>
        )}
      </Card>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? 'Saving…' : 'Add feed'}
      </Button>
    </form>
  )
}
