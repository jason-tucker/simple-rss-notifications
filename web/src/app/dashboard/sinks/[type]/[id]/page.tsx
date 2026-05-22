import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { SinkForm, type SinkInitial } from '@/components/SinkForm'

export const dynamic = 'force-dynamic'

export default async function EditSinkPage({
  params,
}: {
  params: Promise<{ type: string; id: string }>
}) {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  const { type, id } = await params
  if (type !== 'smtp' && type !== 'resend' && type !== 'ntfy') notFound()

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
    } else {
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
    }
  })

  if (!sink) notFound()

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Edit {type.toUpperCase()} sink</h1>
        <p className="mt-1 text-sm text-zinc-500">
          <Link href="/dashboard/sinks" className="hover:text-zinc-300">← back to sinks</Link>
        </p>
      </header>
      <SinkForm mode="edit" type={type} initial={sink} />
    </div>
  )
}
