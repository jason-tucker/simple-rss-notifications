import Link from 'next/link'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { SinkRow, type SinkSummary } from '@/components/SinkRow'

export const dynamic = 'force-dynamic'

export default async function SinksPage() {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  const sinks: SinkSummary[] = await withUser(session.uid, async (tx) => {
    const smtp = await tx.execute<{
      id: string; label: string; host: string; port: number; username: string
      from_email: string; from_name: string | null; use_tls: boolean
      incomplete: boolean; has_secret: boolean
    }>(sql`
      SELECT id, label, host, port, username, from_email, from_name, use_tls,
             incomplete, (password_ciphertext IS NOT NULL) AS has_secret
      FROM sinks_smtp ORDER BY created_at
    `)
    const resend = await tx.execute<{
      id: string; label: string; from_email: string; from_name: string | null
      incomplete: boolean; has_secret: boolean
    }>(sql`
      SELECT id, label, from_email, from_name,
             incomplete, (api_key_ciphertext IS NOT NULL) AS has_secret
      FROM sinks_resend ORDER BY created_at
    `)
    const ntfy = await tx.execute<{
      id: string; label: string; server_url: string; topic: string
      default_priority: number; default_tags: string | null; include_link: boolean
      incomplete: boolean; has_secret: boolean
    }>(sql`
      SELECT id, label, server_url, topic, default_priority, default_tags, include_link,
             incomplete, (token_ciphertext IS NOT NULL) AS has_secret
      FROM sinks_ntfy ORDER BY created_at
    `)
    return [
      ...smtp.map((s) => ({ type: 'smtp' as const, ...s })),
      ...resend.map((s) => ({ type: 'resend' as const, ...s })),
      ...ntfy.map((s) => ({ type: 'ntfy' as const, ...s })),
    ]
  })

  const anyIncomplete = sinks.some((s) => s.incomplete)

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Sinks</h1>
        <div className="flex gap-2">
          <Link href="/dashboard/sinks/new?type=smtp" className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">+ SMTP</Link>
          <Link href="/dashboard/sinks/new?type=resend" className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">+ Resend</Link>
          <Link href="/dashboard/sinks/new?type=ntfy" className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">+ ntfy</Link>
        </div>
      </header>

      <p className="text-sm text-zinc-400">
        Outbound destinations. Pair a sink with a feed via a{' '}
        <Link href="/dashboard/routes" className="underline hover:text-zinc-200">route</Link>{' '}
        to actually send notifications.
      </p>

      {anyIncomplete && (
        <div className="rounded border border-amber-700 bg-amber-950 px-3 py-2 text-sm text-amber-200">
          One or more sinks are incomplete — paste the missing password / API key to enable them.
        </div>
      )}

      {sinks.length === 0 ? (
        <div className="rounded border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-500">
          No sinks yet. Add one above to get started.
        </div>
      ) : (
        <ul className="space-y-2">
          {sinks.map((s) => <SinkRow key={`${s.type}:${s.id}`} sink={s} />)}
        </ul>
      )}

      <p className="text-xs text-zinc-600">
        <Link href="/" className="hover:text-zinc-400">← back to dashboard</Link>
      </p>
    </div>
  )
}
