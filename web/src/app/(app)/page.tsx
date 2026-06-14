import Link from 'next/link'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { ButtonLink, Callout, Card, PageHeader, cx } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function OverviewPage() {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  const stats = await withUser(session.uid, async (tx) => {
    const rows = await tx.execute<{
      sinks_total: number; sinks_incomplete: number
      feeds_total: number; feeds_enabled: number
      feeds_unhealthy: number
      routes_total: number; routes_enabled: number
      dispatches_pending: number; dispatches_failed_24h: number
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM sinks_smtp) + (SELECT count(*)::int FROM sinks_resend) + (SELECT count(*)::int FROM sinks_ntfy) + (SELECT count(*)::int FROM sinks_discord_webhook) AS sinks_total,
        (SELECT count(*)::int FROM sinks_smtp WHERE incomplete) + (SELECT count(*)::int FROM sinks_resend WHERE incomplete) + (SELECT count(*)::int FROM sinks_ntfy WHERE incomplete) + (SELECT count(*)::int FROM sinks_discord_webhook WHERE incomplete) AS sinks_incomplete,
        (SELECT count(*)::int FROM feeds) AS feeds_total,
        (SELECT count(*)::int FROM feeds WHERE enabled) AS feeds_enabled,
        (SELECT count(*)::int FROM feeds WHERE consecutive_failures > 0) AS feeds_unhealthy,
        (SELECT count(*)::int FROM routes) AS routes_total,
        (SELECT count(*)::int FROM routes WHERE enabled) AS routes_enabled,
        (SELECT count(*)::int FROM dispatches WHERE status = 'pending') AS dispatches_pending,
        (SELECT count(*)::int FROM dispatches WHERE status = 'failed' AND dispatched_at > now() - interval '24 hours') AS dispatches_failed_24h
    `)
    return rows[0]!
  })

  const steps = [
    { done: stats.sinks_total > 0, title: 'Add a sink', hint: 'where notifications go — email, ntfy push, or Discord', href: '/dashboard/sinks/new' },
    { done: stats.feeds_total > 0, title: 'Add a feed', hint: 'an RSS URL to watch for new items', href: '/dashboard/feeds/new' },
    { done: stats.routes_total > 0, title: 'Create a route', hint: 'connect a feed to one or more sinks', href: '/dashboard/routes/new' },
  ]
  const setupDone = steps.every((s) => s.done)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Watch RSS feeds and get notified by email, push, or Discord — everything is configured right here, no restarts."
      />

      {stats.sinks_incomplete > 0 && (
        <Callout tone="warn">
          <Link href="/dashboard/sinks" className="underline">
            {stats.sinks_incomplete} incomplete sink{stats.sinks_incomplete === 1 ? '' : 's'}
          </Link>
          {' — paste the missing password or API key to enable.'}
        </Callout>
      )}

      {stats.feeds_unhealthy > 0 && (
        <Callout tone="danger">
          <Link href="/dashboard/activity" className="underline">
            {stats.feeds_unhealthy} feed{stats.feeds_unhealthy === 1 ? '' : 's'} failing to poll
          </Link>
          {' — the worker can’t fetch the URL. Check the feed for the underlying error.'}
        </Callout>
      )}

      {!setupDone && (
        <Card className="space-y-3 p-5">
          <p className="text-sm font-medium text-zinc-200">Get set up in three steps</p>
          <ol className="space-y-3">
            {steps.map((s, i) => (
              <li key={s.title} className="flex items-center gap-3">
                <span
                  className={cx(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium',
                    s.done ? 'bg-emerald-950 text-emerald-300 ring-1 ring-inset ring-emerald-900' : 'bg-zinc-800 text-zinc-300',
                  )}
                >
                  {s.done ? '✓' : i + 1}
                </span>
                <p className="min-w-0 flex-1 text-sm">
                  <span className={s.done ? 'text-zinc-500 line-through' : 'text-zinc-200'}>{s.title}</span>
                  <span className="text-zinc-500"> — {s.hint}</span>
                </p>
                {!s.done && <ButtonLink size="sm" href={s.href}>Go</ButtonLink>}
              </li>
            ))}
          </ol>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard href="/dashboard/feeds" label="Feeds" value={stats.feeds_total} sub={`${stats.feeds_enabled} active · RSS sources`} />
        <StatCard href="/dashboard/routes" label="Routes" value={stats.routes_total} sub={`${stats.routes_enabled} active · feed → sink`} />
        <StatCard href="/dashboard/sinks" label="Sinks" value={stats.sinks_total} sub="email · ntfy · Discord" />
      </div>

      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="text-sm">
          <span className="font-medium text-zinc-200">Activity</span>
          <span className="text-zinc-500">{' · '}{stats.dispatches_pending} pending</span>
          {stats.dispatches_failed_24h > 0 && (
            <Link href="/dashboard/activity?status=failed" className="text-red-400 underline hover:text-red-300">
              {' · '}{stats.dispatches_failed_24h} failed in 24h
            </Link>
          )}
        </div>
        <ButtonLink size="sm" href="/dashboard/activity">View activity →</ButtonLink>
      </Card>
    </div>
  )
}

function StatCard({ href, label, value, sub }: { href: string; label: string; value: number; sub: string }) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 transition-colors hover:border-zinc-600"
    >
      <div className="text-sm text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-zinc-100">{value}</div>
      <div className="mt-1 text-xs text-zinc-500">{sub}</div>
    </Link>
  )
}
