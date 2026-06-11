import { redirect, notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { SinkForm, type SinkInitial } from '@/components/SinkForm'
import { PageHeader } from '@/components/ui'
import { SINK_TYPE_LABELS } from '@/lib/format'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Edit sink' }

export default async function EditSinkPage({
  params,
}: {
  params: Promise<{ type: string; id: string }>
}) {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  const { type, id } = await params
  if (type !== 'smtp' && type !== 'resend' && type !== 'ntfy' && type !== 'discord_webhook') notFound()

  const sink = await withUser(session.uid, async (tx): Promise<SinkInitial | undefined> => {
    if (type === 'smtp') {
      const rows = await tx.execute<{
        id: string; label: string; host: string; port: number; username: string
        from_email: string; from_name: string | null; use_tls: boolean
        incomplete: boolean; has_secret: boolean
      }>(sql`
        SELECT id, label, host, port, username, from_email, from_name, use_tls,
               incomplete, (password_ciphertext IS NOT NULL) AS has_secret
        FROM sinks_smtp WHERE id = ${id}::uuid LIMIT 1
      `)
      return rows[0]
    } else if (type === 'resend') {
      const rows = await tx.execute<{
        id: string; label: string; from_email: string; from_name: string | null
        incomplete: boolean; has_secret: boolean
      }>(sql`
        SELECT id, label, from_email, from_name,
               incomplete, (api_key_ciphertext IS NOT NULL) AS has_secret
        FROM sinks_resend WHERE id = ${id}::uuid LIMIT 1
      `)
      return rows[0]
    } else if (type === 'ntfy') {
      const rows = await tx.execute<{
        id: string; label: string; server_url: string; topic: string
        default_priority: number; default_tags: string | null; include_link: boolean
        incomplete: boolean; has_secret: boolean
      }>(sql`
        SELECT id, label, server_url, topic, default_priority, default_tags, include_link,
               incomplete, (token_ciphertext IS NOT NULL) AS has_secret
        FROM sinks_ntfy WHERE id = ${id}::uuid LIMIT 1
      `)
      return rows[0]
    } else {
      const rows = await tx.execute<{
        id: string; label: string; username: string | null; avatar_url: string | null
        use_embeds: boolean; incomplete: boolean; has_secret: boolean
      }>(sql`
        SELECT id, label, username, avatar_url, use_embeds, incomplete,
               (webhook_url_ciphertext IS NOT NULL) AS has_secret
        FROM sinks_discord_webhook WHERE id = ${id}::uuid LIMIT 1
      `)
      const r = rows[0]
      if (!r) return undefined
      return { ...r, username: r.username ?? undefined }
    }
  })

  if (!sink) notFound()

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader title={`Edit ${SINK_TYPE_LABELS[type]} sink`} description={sink.label} />
      <SinkForm mode="edit" type={type} initial={sink} />
    </div>
  )
}
