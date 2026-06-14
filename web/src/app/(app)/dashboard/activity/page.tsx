import Link from 'next/link'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { ActivityList, type ActivityRow } from '@/components/ActivityList'
import { Callout, PageHeader, cx } from '@/components/ui'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Activity' }

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

  // Five independent read queries fan out across separate connections via
  // parallel withUser() calls (postgres-js serializes within one tx).
  const [rows, totalRows, feeds, counts, unhealthy] = await Promise.all([
    withUser(session.uid, (tx) => tx.execute<{
      id: string; status: string; attempts: number
      scheduled_at: Date; dispatched_at: Date | null
      error: string | null; provider_message_id: string | null
      created_at: Date
      route_id: string; route_label: string | null
      feed_id: string; feed_label: string
      item_title: string | null; item_link: string | null; item_published_at: Date | null
      sink_type: string; sink_id: string; destination: string | null
      sink_label: string | null
    }>(sql`
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
    `)),
    withUser(session.uid, (tx) => tx.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c FROM dispatches d
      JOIN feed_items fi ON fi.id = d.feed_item_id
      WHERE (${status}::text IS NULL OR d.status = ${status}::text)
        AND (${feedFilter}::uuid IS NULL OR fi.feed_id = ${feedFilter}::uuid)
    `)),
    withUser(session.uid, (tx) => tx.execute<{ id: string; label: string }>(sql`
      SELECT id, label FROM feeds ORDER BY label
    `)),
    withUser(session.uid, (tx) => tx.execute<{ status: string; c: number }>(sql`
      SELECT status, count(*)::int AS c FROM dispatches GROUP BY status
    `)),
    withUser(session.uid, (tx) => tx.execute<{
      id: string; label: string; url: string
      consecutive_failures: number; last_error: string | null; last_error_at: Date | null
    }>(sql`
      SELECT id, label, url, consecutive_failures, last_error, last_error_at
      FROM feeds
      WHERE consecutive_failures > 0
      ORDER BY consecutive_failures DESC
    `)),
  ])
  const total = totalRows[0]?.c ?? 0

  const countMap = Object.fromEntries(counts.map((c) => [c.status, c.c])) as Record<string, number>
  const allCount = (countMap.sent ?? 0) + (countMap.failed ?? 0) + (countMap.pending ?? 0) + (countMap.skipped ?? 0)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity"
        description="Every notification — what got sent, where, and any failures."
      />

      {unhealthy.length > 0 && (
        <Callout tone="danger">
          <div className="space-y-2">
            <p className="font-medium">
              {unhealthy.length} feed{unhealthy.length === 1 ? '' : 's'} can&apos;t be fetched
            </p>
            <p className="text-xs text-red-300">
              These are <em>poll</em> failures (the worker can&apos;t reach the URL) — they don&apos;t show up
              below as dispatches because no items are being read in the first place. Fix the feed URL
              to clear them.
            </p>
            <ul className="space-y-1.5 text-xs">
              {unhealthy.map((f) => (
                <li key={f.id} className="rounded bg-red-950/60 p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={`/dashboard/feeds/${f.id}`} className="font-medium text-red-100 hover:underline">
                      {f.label}
                    </Link>
                    <span className="text-red-300">{f.consecutive_failures} consecutive failure{f.consecutive_failures === 1 ? '' : 's'}</span>
                  </div>
                  <code className="mt-1 block break-all text-red-300/80">{f.url}</code>
                  {f.last_error && <p className="mt-1 text-red-400">last error: {f.last_error}</p>}
                </li>
              ))}
            </ul>
          </div>
        </Callout>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <FilterChip href={filterHref(null, feedFilter)} active={!status} label={`All (${allCount})`} />
        <FilterChip href={filterHref('pending', feedFilter)} active={status === 'pending'} label={`Pending (${countMap.pending ?? 0})`} />
        <FilterChip href={filterHref('sent', feedFilter)} active={status === 'sent'} label={`Sent (${countMap.sent ?? 0})`} />
        <FilterChip href={filterHref('failed', feedFilter)} active={status === 'failed'} label={`Failed (${countMap.failed ?? 0})`} className={status === 'failed' ? '' : 'border-red-900 text-red-300'} />
        <FilterChip href={filterHref('skipped', feedFilter)} active={status === 'skipped'} label={`Skipped (${countMap.skipped ?? 0})`} />
        {feeds.length > 0 && <FeedFilterForm feeds={feeds} current={feedFilter ?? ''} status={status} />}
      </div>

      <ActivityList rows={rows.map(toActivityRow)} total={total} />
    </div>
  )
}

function filterHref(status: string | null, feed: string | null): string {
  const q = new URLSearchParams()
  if (status) q.set('status', status)
  if (feed) q.set('feed', feed)
  const s = q.toString()
  return s ? `/dashboard/activity?${s}` : '/dashboard/activity'
}

function FilterChip({ href, active, label, className }: { href: string; active: boolean; label: string; className?: string }) {
  return (
    <Link
      href={href}
      className={cx(
        'rounded-md border px-2.5 py-1 transition-colors',
        active ? 'border-zinc-200 bg-zinc-100 text-zinc-900' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800',
        className,
      )}
    >
      {label}
    </Link>
  )
}

function FeedFilterForm({ feeds, current, status }: { feeds: Array<{ id: string; label: string }>; current: string; status: string | null }) {
  return (
    <form action="/dashboard/activity" className="flex items-center gap-1">
      {status && <input type="hidden" name="status" value={status} />}
      <select name="feed" defaultValue={current} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100">
        <option value="">All feeds</option>
        {feeds.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
      </select>
      <button type="submit" className="rounded-md border border-zinc-700 px-2.5 py-1 text-zinc-300 hover:bg-zinc-800">Apply</button>
    </form>
  )
}

// Server-component query returns Date objects; the client component wants
// ISO strings so it can pass through Next's RSC serialization cleanly.
function toActivityRow(r: {
  id: string; status: string; attempts: number
  scheduled_at: Date; dispatched_at: Date | null
  error: string | null; provider_message_id: string | null
  created_at: Date
  route_id: string; route_label: string | null
  feed_id: string; feed_label: string
  item_title: string | null; item_link: string | null
  sink_type: string; sink_id: string; destination: string | null
  sink_label: string | null
}): ActivityRow {
  return {
    id: r.id,
    status: r.status,
    attempts: r.attempts,
    scheduled_at: new Date(r.scheduled_at).toISOString(),
    dispatched_at: r.dispatched_at ? new Date(r.dispatched_at).toISOString() : null,
    error: r.error,
    provider_message_id: r.provider_message_id,
    created_at: new Date(r.created_at).toISOString(),
    route_id: r.route_id,
    route_label: r.route_label,
    feed_id: r.feed_id,
    feed_label: r.feed_label,
    item_title: r.item_title,
    item_link: r.item_link,
    sink_type: r.sink_type,
    sink_id: r.sink_id,
    destination: r.destination,
    sink_label: r.sink_label,
  }
}
