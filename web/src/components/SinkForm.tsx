'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface InitialSmtp {
  id: string; label: string; host: string; port: number; username: string
  from_email: string; from_name: string | null; use_tls: boolean
  incomplete: boolean; has_secret: boolean
}
interface InitialResend {
  id: string; label: string; from_email: string; from_name: string | null
  incomplete: boolean; has_secret: boolean
}

interface PropsNew {
  mode: 'new'
  type: 'smtp' | 'resend'
  initial?: undefined
}
interface PropsEditSmtp {
  mode: 'edit'
  type: 'smtp'
  initial: InitialSmtp
}
interface PropsEditResend {
  mode: 'edit'
  type: 'resend'
  initial: InitialResend
}

type Props = PropsNew | PropsEditSmtp | PropsEditResend

export function SinkForm(props: Props) {
  const router = useRouter()
  const isEdit = props.mode === 'edit'
  const type = props.type
  const init = isEdit ? props.initial : null

  const [label, setLabel] = useState((init?.label as string) ?? '')
  const [fromEmail, setFromEmail] = useState(init?.from_email ?? '')
  const [fromName, setFromName] = useState((init?.from_name as string | null) ?? '')

  // SMTP-only
  const [host, setHost] = useState(type === 'smtp' ? (init && 'host' in init ? init.host : '') : '')
  const [port, setPort] = useState(type === 'smtp' ? (init && 'port' in init ? String(init.port) : '587') : '587')
  const [username, setUsername] = useState(type === 'smtp' ? (init && 'username' in init ? init.username : '') : '')
  const [useTls, setUseTls] = useState<boolean>(type === 'smtp' ? (init && 'use_tls' in init ? init.use_tls : true) : true)
  const [password, setPassword] = useState('')

  // Resend-only
  const [apiKey, setApiKey] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const url = isEdit ? `/api/sinks/${type}/${init!.id}` : '/api/sinks'
      const method = isEdit ? 'PATCH' : 'POST'
      const body: Record<string, unknown> = isEdit ? {} : { type }
      body.label = label
      body.from_email = fromEmail
      body.from_name = fromName.trim() || null
      if (type === 'smtp') {
        body.host = host
        body.port = Number(port)
        body.username = username
        body.use_tls = useTls
        if (password) body.password = password
      } else {
        if (apiKey) body.api_key = apiKey
      }
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `Save failed (${res.status})`)
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

  const passwordPlaceholder = isEdit && init?.has_secret
    ? 'leave blank to keep current'
    : 'required'

  const inputCls = 'mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-500'

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="text-sm text-zinc-400">Label</span>
        <input required maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls} placeholder={type === 'smtp' ? 'e.g. IONOS' : 'e.g. Resend prod'} />
      </label>
      <label className="block">
        <span className="text-sm text-zinc-400">From email</span>
        <input required type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} className={inputCls} placeholder="online@jasontucker.me" />
      </label>
      <label className="block">
        <span className="text-sm text-zinc-400">From name <span className="text-zinc-600">(optional)</span></span>
        <input maxLength={100} value={fromName} onChange={(e) => setFromName(e.target.value)} className={inputCls} />
      </label>

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
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={passwordPlaceholder} className={inputCls} />
            <span className="mt-1 block text-xs text-zinc-500">
              Encrypted at rest with AES-256-GCM. {isEdit && init?.has_secret ? 'Leave blank to keep the current password; type a new one to rotate it.' : 'Required to enable this sink.'}
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
          <input type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={passwordPlaceholder} className={inputCls} />
          <span className="mt-1 block text-xs text-zinc-500">
            Encrypted at rest. {isEdit && init?.has_secret ? 'Leave blank to keep the current key.' : 'Required.'}
          </span>
        </label>
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
