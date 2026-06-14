'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, CheckboxRow, Field, Input, Select } from '@/components/ui'

export interface SinkInitial {
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
  // discord_webhook only (note `username` is shared but means a different
  // thing — Discord display name override)
  avatar_url?: string | null
  use_embeds?: boolean
}

interface Props {
  mode: 'new' | 'edit'
  type: 'smtp' | 'resend' | 'ntfy' | 'discord_webhook'
  initial?: SinkInitial
}

export function SinkForm({ mode, type, initial }: Props) {
  const router = useRouter()
  const isEdit = mode === 'edit'

  const [label, setLabel] = useState(initial?.label ?? '')

  // SMTP / Resend
  const [fromEmail, setFromEmail] = useState(initial?.from_email ?? '')
  const [fromName, setFromName] = useState(initial?.from_name ?? '')

  // SMTP
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(initial?.port != null ? String(initial.port) : '587')
  const [username, setUsername] = useState(initial?.username ?? '')
  const [useTls, setUseTls] = useState<boolean>(initial?.use_tls ?? true)
  const [password, setPassword] = useState('')

  // Resend
  const [apiKey, setApiKey] = useState('')

  // ntfy
  const [serverUrl, setServerUrl] = useState(initial?.server_url ?? 'https://ntfy.sh')
  const [topic, setTopic] = useState(initial?.topic ?? '')
  const [token, setToken] = useState('')
  const [priority, setPriority] = useState(String(initial?.default_priority ?? 3))
  const [tags, setTags] = useState(initial?.default_tags ?? '')
  const [includeLink, setIncludeLink] = useState<boolean>(initial?.include_link ?? true)

  // Discord webhook
  const [webhookUrl, setWebhookUrl] = useState('')
  const [discordUsername, setDiscordUsername] = useState(initial?.username ?? '')
  const [avatarUrl, setAvatarUrl] = useState(initial?.avatar_url ?? '')
  const [useEmbeds, setUseEmbeds] = useState<boolean>(initial?.use_embeds ?? true)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const url = isEdit ? `/api/sinks/${type}/${initial!.id}` : '/api/sinks'
      const method = isEdit ? 'PATCH' : 'POST'
      const body: Record<string, unknown> = isEdit ? {} : { type }
      body.label = label
      if (type === 'smtp') {
        body.from_email = fromEmail
        body.from_name = fromName.trim() || null
        body.host = host
        body.port = Number(port)
        body.username = username
        body.use_tls = useTls
        if (password) body.password = password
      } else if (type === 'resend') {
        body.from_email = fromEmail
        body.from_name = fromName.trim() || null
        if (apiKey) body.api_key = apiKey
      } else if (type === 'ntfy') {
        body.server_url = serverUrl
        body.topic = topic
        body.default_priority = Number(priority)
        body.default_tags = tags.trim() || null
        body.include_link = includeLink
        if (token) body.token = token
      } else {
        // discord_webhook
        body.username = discordUsername.trim() || null
        body.avatar_url = avatarUrl.trim() || null
        body.use_embeds = useEmbeds
        if (webhookUrl) body.webhook_url = webhookUrl
      }
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string }
        setError(errBody.error ?? `Save failed (${res.status})`)
        setBusy(false)
        return
      }
      router.replace('/dashboard/sinks')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
      setBusy(false)
    }
  }

  const secretPlaceholder = isEdit && initial?.has_secret ? 'leave blank to keep current' : 'optional'
  const requiredSecretPlaceholder = isEdit && initial?.has_secret ? 'leave blank to keep current' : 'required'

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Name" hint="Anything that helps you recognize it.">
        <Input required maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)}
          placeholder={type === 'smtp' ? 'e.g. IONOS' : type === 'resend' ? 'e.g. Resend prod' : type === 'ntfy' ? 'e.g. My phone' : 'e.g. #alerts channel'} />
      </Field>

      {(type === 'smtp' || type === 'resend') && (
        <>
          <Field label="From email">
            <Input required type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="notify@example.com" />
          </Field>
          <Field label="From name" optional>
            <Input maxLength={100} value={fromName} onChange={(e) => setFromName(e.target.value)} />
          </Field>
        </>
      )}

      {type === 'smtp' && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="Host">
                <Input required value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" />
              </Field>
            </div>
            <Field label="Port">
              <Input required type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
            </Field>
          </div>
          <Field label="Username">
            <Input required value={username} onChange={(e) => setUsername(e.target.value)} placeholder="notify@example.com" />
          </Field>
          <Field
            label="Password"
            hint={`Encrypted at rest. ${isEdit && initial?.has_secret ? 'Leave blank to keep current; type a new value to rotate.' : 'Required.'}`}
          >
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={requiredSecretPlaceholder} />
          </Field>
          <CheckboxRow label="Require TLS (recommended)" checked={useTls} onChange={(e) => setUseTls(e.target.checked)} />
        </>
      )}

      {type === 'resend' && (
        <Field
          label="API key"
          hint={`Encrypted at rest. ${isEdit && initial?.has_secret ? 'Leave blank to keep the current key.' : 'Required.'}`}
        >
          <Input type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={requiredSecretPlaceholder} />
        </Field>
      )}

      {type === 'discord_webhook' && (
        <>
          <Field
            label="Webhook URL"
            hint={
              <>
                Encrypted at rest. Get from Discord channel settings → Integrations → Webhooks → Copy URL. Must start with{' '}
                <code className="text-zinc-300">https://discord.com/api/webhooks/</code>.
                {isEdit && initial?.has_secret ? ' Leave blank to keep current.' : ''}
              </>
            }
          >
            <Input type="password" autoComplete="new-password" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder={requiredSecretPlaceholder} />
          </Field>
          <Field label="Display name" optional hint="Overrides the webhook's default bot name.">
            <Input maxLength={80} value={discordUsername} onChange={(e) => setDiscordUsername(e.target.value)} placeholder="Euphoric Notify" />
          </Field>
          <Field label="Avatar URL" optional>
            <Input type="url" maxLength={2048} value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://…/logo.png" />
          </Field>
          <CheckboxRow
            label="Send as rich embed (title + description + URL). Uncheck for plain text."
            checked={useEmbeds}
            onChange={(e) => setUseEmbeds(e.target.checked)}
          />
        </>
      )}

      {type === 'ntfy' && (
        <>
          <Field label="Server URL" hint="Defaults to the public ntfy.sh. Use your own URL for a self-hosted instance.">
            <Input required type="url" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://ntfy.sh" />
          </Field>
          <Field label="Topic" hint="Letters, numbers, dash, or underscore. Subscribe to this topic in the ntfy app.">
            <Input required maxLength={64} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="my-feeds" />
          </Field>
          <Field label="Access token" optional hint="Encrypted at rest. Leave blank for public topics.">
            <Input type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={secretPlaceholder} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Default priority">
              <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="1">1 — min</option>
                <option value="2">2 — low</option>
                <option value="3">3 — default</option>
                <option value="4">4 — high</option>
                <option value="5">5 — max</option>
              </Select>
            </Field>
            <Field label="Default tags" hint="Comma-separated. ntfy renders matching ones as emoji.">
              <Input maxLength={200} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="rss,info" />
            </Field>
          </div>
          <CheckboxRow
            label="Open the feed item's link when the push is tapped"
            checked={includeLink}
            onChange={(e) => setIncludeLink(e.target.checked)}
          />
        </>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? 'Saving…' : (isEdit ? 'Save changes' : 'Add sink')}
      </Button>
    </form>
  )
}
