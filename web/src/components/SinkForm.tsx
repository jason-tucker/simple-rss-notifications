'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

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
}

interface Props {
  mode: 'new' | 'edit'
  type: 'smtp' | 'resend' | 'ntfy'
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
      } else {
        body.server_url = serverUrl
        body.topic = topic
        body.default_priority = Number(priority)
        body.default_tags = tags.trim() || null
        body.include_link = includeLink
        if (token) body.token = token
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

  const inputCls = 'mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-500'

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="text-sm text-zinc-400">Label</span>
        <input required maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls}
          placeholder={type === 'smtp' ? 'e.g. IONOS' : type === 'resend' ? 'e.g. Resend prod' : 'e.g. My phone (ntfy)'} />
      </label>

      {(type === 'smtp' || type === 'resend') && (
        <>
          <label className="block">
            <span className="text-sm text-zinc-400">From email</span>
            <input required type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} className={inputCls} placeholder="online@jasontucker.me" />
          </label>
          <label className="block">
            <span className="text-sm text-zinc-400">From name <span className="text-zinc-600">(optional)</span></span>
            <input maxLength={100} value={fromName} onChange={(e) => setFromName(e.target.value)} className={inputCls} />
          </label>
        </>
      )}

      {type === 'smtp' && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <label className="col-span-2 block">
              <span className="text-sm text-zinc-400">Host</span>
              <input required value={host} onChange={(e) => setHost(e.target.value)} className={inputCls} placeholder="smtp.ionos.com" />
            </label>
            <label className="block">
              <span className="text-sm text-zinc-400">Port</span>
              <input required type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} className={inputCls} />
            </label>
          </div>
          <label className="block">
            <span className="text-sm text-zinc-400">Username</span>
            <input required value={username} onChange={(e) => setUsername(e.target.value)} className={inputCls} placeholder="online@jasontucker.me" />
          </label>
          <label className="block">
            <span className="text-sm text-zinc-400">Password</span>
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={requiredSecretPlaceholder} className={inputCls} />
            <span className="mt-1 block text-xs text-zinc-500">
              Encrypted at rest. {isEdit && initial?.has_secret ? 'Leave blank to keep current; type a new value to rotate.' : 'Required.'}
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <input type="checkbox" checked={useTls} onChange={(e) => setUseTls(e.target.checked)} />
            Require TLS (recommended)
          </label>
        </>
      )}

      {type === 'resend' && (
        <label className="block">
          <span className="text-sm text-zinc-400">API key</span>
          <input type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={requiredSecretPlaceholder} className={inputCls} />
          <span className="mt-1 block text-xs text-zinc-500">
            Encrypted at rest. {isEdit && initial?.has_secret ? 'Leave blank to keep the current key.' : 'Required.'}
          </span>
        </label>
      )}

      {type === 'ntfy' && (
        <>
          <label className="block">
            <span className="text-sm text-zinc-400">Server URL</span>
            <input required type="url" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} className={inputCls} placeholder="https://ntfy.sh" />
            <span className="mt-1 block text-xs text-zinc-500">Defaults to the public ntfy.sh. Use your own URL for a self-hosted instance.</span>
          </label>
          <label className="block">
            <span className="text-sm text-zinc-400">Topic</span>
            <input required maxLength={64} value={topic} onChange={(e) => setTopic(e.target.value)} className={inputCls} placeholder="my-feeds-tucker" />
            <span className="mt-1 block text-xs text-zinc-500">Alphanumeric, dash, or underscore. Subscribe to this topic in the ntfy app.</span>
          </label>
          <label className="block">
            <span className="text-sm text-zinc-400">Access token <span className="text-zinc-600">(only if topic is protected)</span></span>
            <input type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={secretPlaceholder} className={inputCls} />
            <span className="mt-1 block text-xs text-zinc-500">Encrypted at rest. Leave blank for public topics.</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm text-zinc-400">Default priority</span>
              <select value={priority} onChange={(e) => setPriority(e.target.value)} className={inputCls}>
                <option value="1">1 — min</option>
                <option value="2">2 — low</option>
                <option value="3">3 — default</option>
                <option value="4">4 — high</option>
                <option value="5">5 — max</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm text-zinc-400">Default tags</span>
              <input maxLength={200} value={tags} onChange={(e) => setTags(e.target.value)} className={inputCls} placeholder="rss,info" />
              <span className="mt-1 block text-xs text-zinc-500">Comma-separated. ntfy renders matching ones as emoji.</span>
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <input type="checkbox" checked={includeLink} onChange={(e) => setIncludeLink(e.target.checked)} />
            Include the feed item&apos;s link as the push&apos;s click action
          </label>
        </>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex gap-2 pt-2">
        <button type="submit" disabled={busy} className="rounded bg-zinc-100 px-4 py-2 font-medium text-zinc-900 hover:bg-white disabled:opacity-50">
          {busy ? 'Saving…' : (isEdit ? 'Save changes' : 'Create sink')}
        </button>
      </div>
    </form>
  )
}
