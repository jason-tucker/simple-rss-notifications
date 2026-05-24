'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Initial {
  id: string
  label: string
  url: string
  enabled: boolean
  poll_interval_s: number
  has_cookie: boolean
}

export function EditFeedForm({ initial }: { initial: Initial }) {
  const router = useRouter()
  const [label, setLabel] = useState(initial.label)
  const [url, setUrl] = useState(initial.url)
  const [enabled, setEnabled] = useState(initial.enabled)
  const [pollMinutes, setPollMinutes] = useState(String(Math.round(initial.poll_interval_s / 60)))
  const [cookie, setCookie] = useState('')
  const [clearCookie, setClearCookie] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(`/api/feeds/${initial.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label,
          url,
          enabled,
          poll_interval_s: Math.max(60, Number(pollMinutes) * 60),
          // Three states: don't send field, send a new value, or send clear_cookie.
          ...(clearCookie ? { clear_cookie: true } : cookie.trim() ? { cookie: cookie.trim() } : {}),
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

  const inputCls = 'mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-500'

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="text-sm text-zinc-400">Label</span>
        <input required maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls} />
      </label>
      <label className="block">
        <span className="text-sm text-zinc-400">RSS URL</span>
        <input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} className={inputCls} />
        <span className="mt-1 block text-xs text-zinc-500">Changing the URL resets the HTTP cache hints (etag / last-modified).</span>
      </label>
      <label className="block">
        <span className="text-sm text-zinc-400">Poll interval (minutes)</span>
        <input required type="number" min={1} max={1440} value={pollMinutes} onChange={(e) => setPollMinutes(e.target.value)} className={inputCls} />
      </label>
      <label className="flex items-center gap-2 text-sm text-zinc-400">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>

      <details className="rounded border border-zinc-800 p-3" open={initial.has_cookie}>
        <summary className="cursor-pointer text-xs uppercase tracking-wide text-zinc-500">
          Authentication (optional) {initial.has_cookie && <span className="text-emerald-400 normal-case tracking-normal">— cookie set</span>}
        </summary>
        <div className="mt-3 space-y-2">
          <label className="block">
            <span className="text-sm text-zinc-400">
              Cookie header {initial.has_cookie && <span className="text-xs text-zinc-500">— leave blank to keep the existing one</span>}
            </span>
            <textarea
              value={cookie}
              onChange={(e) => { setCookie(e.target.value); if (e.target.value) setClearCookie(false) }}
              maxLength={8192}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              disabled={clearCookie}
              className={inputCls + ' font-mono text-xs disabled:opacity-40'}
              placeholder={initial.has_cookie ? '(unchanged — type to replace)' : 'xf_user=…; xf_session=…'}
            />
            <span className="mt-1 block text-xs text-zinc-500">
              Sent as the <code className="text-zinc-400">Cookie:</code> header on every poll. Stored encrypted at rest.
            </span>
          </label>
          {initial.has_cookie && (
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              <input type="checkbox" checked={clearCookie} onChange={(e) => setClearCookie(e.target.checked)} />
              Remove the saved cookie
            </label>
          )}
        </div>
      </details>

      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2 pt-2">
        <button type="submit" disabled={busy} className="rounded bg-zinc-100 px-4 py-2 font-medium text-zinc-900 hover:bg-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  )
}
