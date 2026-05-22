import Link from 'next/link'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { RouteRow } from '@/components/RouteRow'

export const dynamic = 'force-dynamic'

export default async function RoutesPage() {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  const data = await withUser(session.uid, async (tx) => {
    const routes = await tx.execute<{
      id: string; feed_id: string; sink_type: string; sink_id: string
      destination: string; label: string | null; enabled: boolean
      feed_label: string; feed_url: string
    }>(sql`
      SELECT r.id, r.feed_id, r.sink_type, r.sink_id, r.destination, r.label, r.enabled,
             f.label AS feed_label, f.url AS feed_url
      FROM routes r JOIN feeds f ON f.id = r.feed_id
      ORDER BY r.created_at
    `)
    return routes
  })

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Routes</h1>
        <Link href="/dashboard/routes/new" className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">+ New route</Link>
      </header>
      <p className="text-sm text-zinc-400">
        A route says &ldquo;new items from <em>this feed</em> get sent to <em>this destination</em> via <em>this sink</em>.&rdquo;
      </p>
      {data.length === 0 ? (
        <div className="rounded border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-500">
          No routes yet. <Link href="/dashboard/routes/new" className="underline hover:text-zinc-300">Add one</Link>.
        </div>
      ) : (
        <ul className="space-y-2">
          {data.map((r) => <RouteRow key={r.id} route={r} />)}
        </ul>
      )}
      <p className="text-xs text-zinc-600">
        <Link href="/" className="hover:text-zinc-400">← back to dashboard</Link>
      </p>
    </div>
  )
}
