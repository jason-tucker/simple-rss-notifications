import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { SinkRow, type SinkSummary } from '@/components/SinkRow'
import { ButtonLink, Callout, EmptyState, PageHeader } from '@/components/ui'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Sinks' }

export default async function SinksPage() {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  // Fan the four sink-table queries out across independent transactions
  // so they run on separate Postgres connections in parallel. Promise.all
  // inside a single tx doesn't help because postgres-js serializes queries
  // on a single connection — withUser ⇒ tx ⇒ one connection. Doing N
  // withUser calls in parallel gives N connections + N parallel SET LOCAL
  // ROLE setups. Wall-clock drops from sum(queries) → max(queries).
  const [smtp, resend, ntfy, discord] = await Promise.all([
    withUser(session.uid, (tx) => tx.execute<{
      id: string; label: string; host: string; port: number; username: string
      from_email: string; from_name: string | null; use_tls: boolean
      incomplete: boolean; has_secret: boolean
    }>(sql`
      SELECT id, label, host, port, username, from_email, from_name, use_tls,
             incomplete, (password_ciphertext IS NOT NULL) AS has_secret
      FROM sinks_smtp ORDER BY created_at
    `)),
    withUser(session.uid, (tx) => tx.execute<{
      id: string; label: string; from_email: string; from_name: string | null
      incomplete: boolean; has_secret: boolean
    }>(sql`
      SELECT id, label, from_email, from_name,
             incomplete, (api_key_ciphertext IS NOT NULL) AS has_secret
      FROM sinks_resend ORDER BY created_at
    `)),
    withUser(session.uid, (tx) => tx.execute<{
      id: string; label: string; server_url: string; topic: string
      default_priority: number; default_tags: string | null; include_link: boolean
      incomplete: boolean; has_secret: boolean
    }>(sql`
      SELECT id, label, server_url, topic, default_priority, default_tags, include_link,
             incomplete, (token_ciphertext IS NOT NULL) AS has_secret
      FROM sinks_ntfy ORDER BY created_at
    `)),
    withUser(session.uid, (tx) => tx.execute<{
      id: string; label: string; username: string | null; avatar_url: string | null
      use_embeds: boolean; incomplete: boolean; has_secret: boolean
    }>(sql`
      SELECT id, label, username, avatar_url, use_embeds, incomplete,
             (webhook_url_ciphertext IS NOT NULL) AS has_secret
      FROM sinks_discord_webhook ORDER BY created_at
    `)),
  ])
  const sinks: SinkSummary[] = [
    ...smtp.map((s) => ({ type: 'smtp' as const, ...s })),
    ...resend.map((s) => ({ type: 'resend' as const, ...s })),
    ...ntfy.map((s) => ({ type: 'ntfy' as const, ...s })),
    ...discord.map((s) => ({ type: 'discord_webhook' as const, ...s, username: s.username ?? undefined })),
  ]

  const anyIncomplete = sinks.some((s) => s.incomplete)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sinks"
        description="Where notifications get delivered — email (SMTP or Resend), ntfy push, or Discord."
        action={<ButtonLink variant="primary" size="sm" href="/dashboard/sinks/new">+ Add sink</ButtonLink>}
      />

      {anyIncomplete && (
        <Callout tone="warn">
          One or more sinks are incomplete — paste the missing password / API key to enable them.
        </Callout>
      )}

      {sinks.length === 0 ? (
        <EmptyState
          title="No sinks yet"
          hint="A sink is where notifications go. Add one, then connect it to a feed with a route."
          action={<ButtonLink variant="primary" size="sm" href="/dashboard/sinks/new">+ Add sink</ButtonLink>}
        />
      ) : (
        <div className="space-y-2">
          {sinks.map((s) => <SinkRow key={`${s.type}:${s.id}`} sink={s} />)}
        </div>
      )}
    </div>
  )
}
