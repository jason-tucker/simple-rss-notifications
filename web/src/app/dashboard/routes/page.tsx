import Link from 'next/link'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { RouteCard } from '@/components/RouteCard'

export const dynamic = 'force-dynamic'

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
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Routes</h1>
        <Link href="/dashboard/routes/new" className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">+ New route</Link>
      </header>
      <p className="text-sm text-zinc-400">
        A route picks one feed and fans new items out to any number of destinations
        (email · ntfy · Discord). Each destination delivers independently.
      </p>
      {data.length === 0 ? (
        <div className="rounded border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-500">
          No routes yet. <Link href="/dashboard/routes/new" className="underline hover:text-zinc-300">Add one</Link>.
        </div>
      ) : (
        <ul className="space-y-3">
          {data.map((r) => <RouteCard key={r.id} route={r} />)}
        </ul>
      )}
      <p className="text-xs text-zinc-600">
        <Link href="/" className="hover:text-zinc-400">← back to dashboard</Link>
      </p>
    </div>
  )
}
