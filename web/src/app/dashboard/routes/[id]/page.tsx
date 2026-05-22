import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { EditRouteForm } from '@/components/EditRouteForm'

export const dynamic = 'force-dynamic'

export default async function EditRoutePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await readSessionCookie()
  if (!session) redirect('/login')
  const { id } = await params

  const data = await withUser(session.uid, async (tx) => {
    const routeRows = await tx.execute<{
      id: string; feed_id: string; label: string | null; enabled: boolean
      feed_label: string
    }>(sql`
      SELECT r.id, r.feed_id, r.label, r.enabled, f.label AS feed_label
      FROM routes r JOIN feeds f ON f.id = r.feed_id
      WHERE r.id = ${id}::uuid LIMIT 1
    `)
    const route = routeRows[0]
    if (!route) return null

    const dests = await tx.execute<{
      id: string; sink_type: string; sink_id: string; destination: string | null; enabled: boolean
      sink_label: string | null
    }>(sql`
      SELECT rd.id, rd.sink_type, rd.sink_id, rd.destination, rd.enabled,
             COALESCE(ssm.label, sre.label, snt.label, sdw.label) AS sink_label
      FROM route_destinations rd
      LEFT JOIN sinks_smtp           ssm ON rd.sink_type='smtp'            AND ssm.id = rd.sink_id
      LEFT JOIN sinks_resend         sre ON rd.sink_type='resend'          AND sre.id = rd.sink_id
      LEFT JOIN sinks_ntfy           snt ON rd.sink_type='ntfy'            AND snt.id = rd.sink_id
      LEFT JOIN sinks_discord_webhook sdw ON rd.sink_type='discord_webhook' AND sdw.id = rd.sink_id
      WHERE rd.route_id = ${id}::uuid
      ORDER BY rd.created_at
    `)

    const smtp = await tx.execute<{ id: string; label: string; incomplete: boolean }>(sql`
      SELECT id, label, incomplete FROM sinks_smtp ORDER BY label
    `)
    const resend = await tx.execute<{ id: string; label: string; incomplete: boolean }>(sql`
      SELECT id, label, incomplete FROM sinks_resend ORDER BY label
    `)
    const ntfy = await tx.execute<{ id: string; label: string; incomplete: boolean }>(sql`
      SELECT id, label, incomplete FROM sinks_ntfy ORDER BY label
    `)
    const discord = await tx.execute<{ id: string; label: string; incomplete: boolean }>(sql`
      SELECT id, label, incomplete FROM sinks_discord_webhook ORDER BY label
    `)
    const sinks = [
      ...smtp.map((s) => ({ ...s, type: 'smtp' as const, topic: null as string | null })),
      ...resend.map((s) => ({ ...s, type: 'resend' as const, topic: null as string | null })),
      ...ntfy.map((s) => ({ ...s, type: 'ntfy' as const, topic: null as string | null })),
      ...discord.map((s) => ({ ...s, type: 'discord_webhook' as const, topic: null as string | null })),
    ]

    return { route, destinations: dests, sinks }
  })

  if (!data) notFound()

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Edit route</h1>
        <p className="mt-1 text-sm text-zinc-500">
          <Link href="/dashboard/routes" className="hover:text-zinc-300">← back to routes</Link>
        </p>
      </header>
      <EditRouteForm route={data.route} destinations={data.destinations} sinks={data.sinks} />
    </div>
  )
}
