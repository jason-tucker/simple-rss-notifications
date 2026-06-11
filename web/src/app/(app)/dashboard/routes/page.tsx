import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { RouteCard } from '@/components/RouteCard'
import { ButtonLink, EmptyState, PageHeader } from '@/components/ui'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Routes' }

export default async function RoutesPage() {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  const data = await withUser(session.uid, async (tx) => {
    const routes = await tx.execute<{
      id: string; feed_id: string; label: string | null; enabled: boolean
      feed_label: string; feed_url: string
    }>(sql`
      SELECT r.id, r.feed_id, r.label, r.enabled,
             f.label AS feed_label, f.url AS feed_url
      FROM routes r JOIN feeds f ON f.id = r.feed_id
      ORDER BY r.created_at
    `)
    if (routes.length === 0) return [] as Array<typeof routes[number] & { destinations: Array<{ id: string; sink_type: string; sink_id: string; destination: string | null; enabled: boolean; sink_label: string | null }> }>

    const ids = routes.map((r) => r.id)
    const dests = await tx.execute<{
      id: string; route_id: string; sink_type: string; sink_id: string
      destination: string | null; enabled: boolean; sink_label: string | null
    }>(sql`
      SELECT rd.id, rd.route_id, rd.sink_type, rd.sink_id, rd.destination, rd.enabled,
             COALESCE(ssm.label, sre.label, snt.label, sdw.label) AS sink_label
      FROM route_destinations rd
      LEFT JOIN sinks_smtp           ssm ON rd.sink_type='smtp'            AND ssm.id = rd.sink_id
      LEFT JOIN sinks_resend         sre ON rd.sink_type='resend'          AND sre.id = rd.sink_id
      LEFT JOIN sinks_ntfy           snt ON rd.sink_type='ntfy'            AND snt.id = rd.sink_id
      LEFT JOIN sinks_discord_webhook sdw ON rd.sink_type='discord_webhook' AND sdw.id = rd.sink_id
      WHERE rd.route_id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])
      ORDER BY rd.created_at
    `)
    type Dest = (typeof dests)[number]
    const byRoute = new Map<string, Dest[]>()
    for (const d of dests) {
      const arr = byRoute.get(d.route_id) ?? []
      arr.push(d)
      byRoute.set(d.route_id, arr)
    }
    return routes.map((r) => ({ ...r, destinations: byRoute.get(r.id) ?? [] }))
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Routes"
        description="A route watches one feed and fans new items out to any number of destinations. Each destination delivers independently."
        action={<ButtonLink variant="primary" size="sm" href="/dashboard/routes/new">+ New route</ButtonLink>}
      />
      {data.length === 0 ? (
        <EmptyState
          title="No routes yet"
          hint="A route is what connects a feed to a sink — without one, nothing gets sent."
          action={<ButtonLink variant="primary" size="sm" href="/dashboard/routes/new">+ New route</ButtonLink>}
        />
      ) : (
        <div className="space-y-3">
          {data.map((r) => <RouteCard key={r.id} route={r} />)}
        </div>
      )}
    </div>
  )
}
