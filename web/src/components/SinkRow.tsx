'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

export interface SinkSummary {
  type: 'smtp' | 'resend' | 'ntfy'
  id: string
  label: string
  incomplete: boolean
  has_secret: boolean
  // SMTP / Resend
  from_email?: string
  from_name?: string | null
  // SMTP only
  host?: string
  port?: number
  username?: string
  use_tls?: boolean
  // ntfy only
  server_url?: string
  topic?: string
  default_priority?: number
  default_tags?: string | null
  include_link?: boolean
}

export function SinkRow({ sink }: { sink: SinkSummary }) {
  const router = useRouter()
  const [testOpen, setTestOpen] = useState(false)
  const [testTo, setTestTo] = useState('')
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [testBusy, setTestBusy] = useState(false)

  const isNtfy = sink.type === 'ntfy'

  async function sendTest() {
    setTestBusy(true)
    setTestMsg(null)
    try {
      const body = isNtfy ? {} : { to: testTo }
      const res = await fetch(`/api/sinks/${sink.type}/${sink.id}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string; providerMessageId?: string }
      if (res.ok && data.ok) {
        setTestMsg({ ok: true, text: `Sent — provider id ${data.providerMessageId ?? '(n/a)'}` })
      } else {
        setTestMsg({ ok: false, text: `${data.code ?? res.status} — ${data.error ?? 'send failed'}` })
      }
    } catch (err) {
      setTestMsg({ ok: false, text: err instanceof Error ? err.message : 'network error' })
    } finally {
      setTestBusy(false)
    }
  }

  async function remove() {
    if (!confirm(`Delete sink "${sink.label}"? This can't be undone.`)) return
    const res = await fetch(`/api/sinks/${sink.type}/${sink.id}`, { method: 'DELETE' })
    if (res.ok) router.refresh()
    else alert('Delete failed')
  }

  return (
    <li className="rounded border border-zinc-800 bg-zinc-900">
      <div className="flex items-center justify-between gap-4 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs uppercase text-zinc-400">{sink.type}</span>
            <span className="truncate font-medium">{sink.label}</span>
            {sink.incomplete && <span className="rounded bg-amber-900 px-1.5 py-0.5 text-xs text-amber-200">incomplete</span>}
          </div>
          <div className="mt-1 text-xs text-zinc-500 truncate">
            {sink.type === 'smtp' && <>{sink.host}:{sink.port} · {sink.username} · from {sink.from_email}{sink.use_tls === false && ' · no TLS'}</>}
            {sink.type === 'resend' && <>Resend · from {sink.from_email}</>}
            {sink.type === 'ntfy' && (
              <>
                {sink.server_url}/{sink.topic} · priority {sink.default_priority}
                {sink.has_secret && ' · token set'}
                {sink.default_tags && ` · tags: ${sink.default_tags}`}
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button onClick={() => setTestOpen((v) => !v)} className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800">
            {testOpen ? 'Cancel' : 'Test'}
          </button>
          <Link href={`/dashboard/sinks/${sink.type}/${sink.id}`} className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800">
            Edit
          </Link>
          <button onClick={remove} className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950">
            Delete
          </button>
        </div>
      </div>
      {testOpen && (
        <div className="border-t border-zinc-800 px-3 py-3 space-y-2">
          {!isNtfy && (
            <label className="block text-xs">
              <span className="text-zinc-400">Send a test email to:</span>
              <input
                type="email"
                required
                placeholder="you@example.com"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              />
            </label>
          )}
          {isNtfy && (
            <p className="text-xs text-zinc-500">
              A test push will be sent to <code className="text-zinc-300">{sink.server_url}/{sink.topic}</code>.
              Make sure you&apos;re subscribed to the topic in the ntfy app.
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={sendTest}
              disabled={testBusy || (!isNtfy && !testTo) || sink.incomplete}
              className="rounded bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-40"
            >
              {testBusy ? 'Sending…' : isNtfy ? 'Send test push' : 'Send test email'}
            </button>
            {sink.incomplete && <span className="text-xs text-amber-400">complete the sink first</span>}
            {testMsg && <span className={`text-xs ${testMsg.ok ? 'text-emerald-300' : 'text-red-400'}`}>{testMsg.text}</span>}
          </div>
        </div>
      )}
    </li>
  )
}
