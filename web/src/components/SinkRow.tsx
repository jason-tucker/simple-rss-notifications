'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Badge, Button, ButtonLink, Card, Field, Input } from '@/components/ui'
import { sinkTypeBadge } from '@/lib/format'

export interface SinkSummary {
  type: 'smtp' | 'resend' | 'ntfy' | 'discord_webhook'
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
  // discord_webhook
  avatar_url?: string | null
  use_embeds?: boolean
}

export function SinkRow({ sink }: { sink: SinkSummary }) {
  const router = useRouter()
  const [testOpen, setTestOpen] = useState(false)
  const [testTo, setTestTo] = useState('')
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [testBusy, setTestBusy] = useState(false)

  const isNtfy = sink.type === 'ntfy'
  const isDiscord = sink.type === 'discord_webhook'
  const noDestination = isNtfy || isDiscord

  async function sendTest() {
    setTestBusy(true)
    setTestMsg(null)
    try {
      const body = noDestination ? {} : { to: testTo }
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
    <Card>
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{sinkTypeBadge(sink.type)}</Badge>
            <span className="truncate font-medium text-zinc-100">{sink.label}</span>
            {sink.incomplete && <Badge tone="warn">incomplete</Badge>}
          </div>
          <div className="mt-1 truncate text-xs text-zinc-500">
            {sink.type === 'smtp' && <>{sink.host}:{sink.port} · {sink.username} · from {sink.from_email}{sink.use_tls === false && ' · no TLS'}</>}
            {sink.type === 'resend' && <>Resend · from {sink.from_email}</>}
            {sink.type === 'ntfy' && (
              <>
                {sink.server_url}/{sink.topic} · priority {sink.default_priority}
                {sink.has_secret && ' · token set'}
                {sink.default_tags && ` · tags: ${sink.default_tags}`}
              </>
            )}
            {sink.type === 'discord_webhook' && (
              <>
                Discord webhook
                {sink.username && ` · as "${sink.username}"`}
                {sink.use_embeds ? ' · embeds' : ' · plain text'}
                {sink.has_secret && ' · URL set'}
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" onClick={() => setTestOpen((v) => !v)}>{testOpen ? 'Cancel' : 'Test'}</Button>
          <ButtonLink size="sm" href={`/dashboard/sinks/${sink.type}/${sink.id}`}>Edit</ButtonLink>
          <Button size="sm" variant="danger" onClick={remove}>Delete</Button>
        </div>
      </div>
      {testOpen && (
        <div className="space-y-2 border-t border-zinc-800 px-4 py-3">
          {!noDestination && (
            <Field label="Send a test email to">
              <Input
                type="email"
                required
                placeholder="you@example.com"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
              />
            </Field>
          )}
          {isNtfy && (
            <p className="text-xs text-zinc-500">
              A test push will be sent to <code className="text-zinc-300">{sink.server_url}/{sink.topic}</code>.
              Make sure you&apos;re subscribed to the topic in the ntfy app.
            </p>
          )}
          {isDiscord && (
            <p className="text-xs text-zinc-500">
              A test message will be posted to the configured Discord webhook.
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={sendTest}
              disabled={testBusy || (!noDestination && !testTo) || sink.incomplete}
            >
              {testBusy ? 'Sending…' : isNtfy ? 'Send test push' : isDiscord ? 'Send test message' : 'Send test email'}
            </Button>
            {sink.incomplete && <span className="text-xs text-amber-400">complete the sink first</span>}
            {testMsg && <span className={`text-xs ${testMsg.ok ? 'text-emerald-300' : 'text-red-400'}`}>{testMsg.text}</span>}
          </div>
        </div>
      )}
    </Card>
  )
}
