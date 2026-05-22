import Link from 'next/link'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { ActivityList, type ActivityRow } from '@/components/ActivityList'

export const dynamic = 'force-dynamic'

const VALID_STATUS = new Set(['pending', 'sent', 'failed', 'skipped'])

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; feed?: string }>
}) {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  const params = await searchParams
  const status = params.status && VALID_STATUS.has(params.status) ? params.status : null
  const feedFilter = params.feed && /^[0-9a-f-]{36}$/.test(params.feed) ? params.feed : null

  const { rows, total, feeds, counts } = await withUser(session.uid, async (tx) => {
    const rows = await tx.execute<ActivityRow & { dispatched_at: Date | null; scheduled_at: Date; item_published_at: Date | null; created_at: Date }>(sql`
      SELECT d.id, d.status, d.attempts, d.scheduled_at, d.dispatched_at,
             d.error, d.provider_message_id, d.created_at,
             r.id AS route_id, r.label AS route_label,
             f.id AS feed_id, f.label AS feed_label,
             fi.title AS item_title, fi.link AS item_link, fi.published_at AS item_published_at,
             rd.sink_type, rd.sink_id, rd.destination,
             COALESCE(ssm.label, sre.label, snt.label, sdw.label) AS sink_label
      FROM dispatches d
      JOIN route_destinations rd ON rd.id = d.route_destination_id
      JOIN routes r ON r.id = d.route_id
      JOIN feed_items fi ON fi.id = d.feed_item_id
      JOIN feeds f ON f.id = fi.feed_id
      LEFT JOIN sinks_smtp           ssm ON rd.sink_type='smtp'            AND ssm.id = rd.sink_id
      LEFT JOIN sinks_resend         sre ON rd.sink_type='resend'          AND sre.id = rd.sink_id
      LEFT JOIN sinks_ntfy           snt ON rd.sink_type='ntfy'            AND snt.id = rd.sink_id
      LEFT JOIN sinks_discord_webhook sdw ON rd.sink_type='discord_webhook' AND sdw.id = rd.sink_id
      WHERE (${status}::text IS NULL OR d.status = ${status}::text)
        AND (${feedFilter}::uuid IS NULL OR f.id = ${feedFilter}::uuid)
      ORDER BY d.created_at DESC
      LIMIT 100
    `)
    const total = await tx.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c FROM dispatches d
      JOIN feed_items fi ON fi.id = d.feed_item_id
      WHERE (${status}::text IS NULL OR d.status = ${status}::text)
        AND (${feedFilter}::uuid IS NULL OR fi.feed_id = ${feedFilter}::uuid)
    `)
    const feeds = await tx.execute<{ id: string; label: string }>(sql`
      SELECT id, label FROM feeds ORDER BY label
    `)
    const counts = await tx.execute<{ status: string; c: number }>(sql`
      SELECT status, count(*)::int AS c FROM dispatches GROUP BY status
    `)
    return { rows, total: total[0]?.c ?? 0, feeds, counts }
  })

  const countMap = Object.fromEntries(counts.map((c) => [c.status, c.c])) as Record<string, number>

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Activity</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Every dispatch through Euphoric Notify — what got sent, where, and any failures.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-zinc-500">Filter:</span>
        <FilterChip href="/dashboard/activity" active={!status && !feedFilter} label={`All (${countMap.sent + countMap.failed + countMap.pending + countMap.skipped || 0})`} />
        <FilterChip href="/dashboard/activity?status=pending" active={status === 'pending'} label={`Pending (${countMap.pending ?? 0})`} />
        <FilterChip href="/dashboard/activity?status=sent" active={status === 'sent'} label={`Sent (${countMap.sent ?? 0})`} />
        <FilterChip href="/dashboard/activity?status=failed" active={status === 'failed'} label={`Failed (${countMap.failed ?? 0})`} className="border-red-900 text-red-300" />
        <FilterChip href="/dashboard/activity?status=skipped" active={status === 'skipped'} label={`Skipped (${countMap.skipped ?? 0})`} />
        {feeds.length > 0 && (
          <select
            defaultValue={feedFilter ?? ''}
            onChange={undefined}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
            // server component — we use a tiny form to navigate.
            // see FeedFilterForm below.
          />
        )}
        <FeedFilterForm feeds={feeds} current={feedFilter ?? ''} status={status} />
      </div>

      <ActivityList rows={rows.map(stringifyDates) as ActivityRow[]} total={total} />

      <p className="text-xs text-zinc-600">
        <Link href="/" className="hover:text-zinc-400">← back to dashboard</Link>
      </p>
    </div>
  )
}

function FilterChip({ href, active, label, className }: { href: string; active: boolean; label: string; className?: string }) {
  return (
    <Link
      href={href}
      className={`rounded border px-2 py-1 ${active ? 'border-zinc-200 bg-zinc-100 text-zinc-900' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'} ${className ?? ''}`}
    >
      {label}
    </Link>
  )
}

function FeedFilterForm({ feeds, current, status }: { feeds: Array<{ id: string; label: string }>; current: string; status: string | null }) {
  return (
    <form action="/dashboard/activity" className="flex items-center gap-1">
      {status && <input type="hidden" name="status" value={status} />}
      <select name="feed" defaultValue={current} className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100">
        <option value="">All feeds</option>
        {feeds.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
      </select>
      <button type="submit" className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800">Apply</button>
    </form>
  )
}

// Server-component query returns Date objects; the client component
// wants strings to keep the network payload + serialization simple.
function stringifyDates<T extends { dispatched_at?: Date | null; scheduled_at?: Date; item_published_at?: Date | null; created_at?: Date }>(row: T): T & { dispatched_at: string | null; scheduled_at: string; created_at: string } {
  return {
    ...row,
    dispatched_at: row.dispatched_at ? new Date(row.dispatched_at).toISOString() : null,
    scheduled_at: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : new Date().toISOString(),
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  } as T & { dispatched_at: string | null; scheduled_at: string; created_at: string }
}
