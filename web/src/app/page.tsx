import Link from 'next/link'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { BUILD_VERSION } from '@/lib/version'
import { LogoutButton } from '@/components/LogoutButton'
import { Brand } from '@/components/Brand'

// Reading cookies + DB inside the page means this must be dynamic — no static
// rendering. (Next 15 would error out if it tried to statically render this.)
export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  const rows = await db.execute<{ must_change_password: boolean; password_changed_at: Date; username: string; is_admin: boolean }>(sql`
    SELECT must_change_password, password_changed_at, username, is_admin FROM users WHERE id = ${session.uid}::uuid LIMIT 1
  `)
  const user = rows[0]
  if (!user) redirect('/login')
  if (Math.floor(new Date(user.password_changed_at).getTime() / 1000) > session.iat) redirect('/login')
  if (user.must_change_password) redirect('/account/password')

  // Counts for the dashboard cards + incomplete banner.
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

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <Brand size={40} className="text-2xl" />
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <span>Signed in as <span className="text-zinc-200">{user.username}</span></span>
          <LogoutButton />
        </div>
      </header>
      <p className="text-zinc-400">
        RSS → email &amp; ntfy bridge. Configure everything in the UI — no server-side
        config files, no restarts on change.
      </p>

      {stats.sinks_incomplete > 0 && (
        <div className="rounded border border-amber-700 bg-amber-950 px-3 py-2 text-sm text-amber-200">
          <Link href="/dashboard/sinks" className="underline">{stats.sinks_incomplete} incomplete sink{stats.sinks_incomplete === 1 ? '' : 's'}</Link>
          {' — paste the missing password or API key to enable.'}
        </div>
      )}

      {stats.feeds_unhealthy > 0 && (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-200">
          <Link href="/dashboard/activity" className="underline">{stats.feeds_unhealthy} feed{stats.feeds_unhealthy === 1 ? '' : 's'} failing to poll</Link>
          {' — the worker can\'t fetch the URL. Check the feed for the underlying error.'}
        </div>
      )}

      <nav className="grid sm:grid-cols-3 gap-3">
        <Link href="/dashboard/feeds" className="rounded border border-zinc-800 bg-zinc-900 p-4 hover:border-zinc-700">
          <div className="text-sm text-zinc-500">Feeds</div>
          <div className="mt-1 text-lg">{stats.feeds_total}</div>
          <div className="mt-1 text-xs text-zinc-500">{stats.feeds_enabled} enabled · RSS sources</div>
        </Link>
        <Link href="/dashboard/routes" className="rounded border border-zinc-800 bg-zinc-900 p-4 hover:border-zinc-700">
          <div className="text-sm text-zinc-500">Routes</div>
          <div className="mt-1 text-lg">{stats.routes_total}</div>
          <div className="mt-1 text-xs text-zinc-500">{stats.routes_enabled} enabled · feed → sink</div>
        </Link>
        <Link href="/dashboard/sinks" className="rounded border border-zinc-800 bg-zinc-900 p-4 hover:border-zinc-700">
          <div className="text-sm text-zinc-500">Sinks</div>
          <div className="mt-1 text-lg">{stats.sinks_total}</div>
          <div className="mt-1 text-xs text-zinc-500">SMTP · Resend · ntfy · Discord</div>
        </Link>
      </nav>

      <div className="text-xs text-zinc-500">
        <Link href="/dashboard/activity" className="hover:text-zinc-300 underline">activity →</Link>
        {' · '}{stats.dispatches_pending} pending
        {stats.dispatches_failed_24h > 0 && (
          <>
            {' · '}
            <Link href="/dashboard/activity?status=failed" className="text-red-400 hover:text-red-300 underline">
              {stats.dispatches_failed_24h} failed in 24h
            </Link>
          </>
        )}
      </div>

      {user.is_admin && (
        <div className="text-xs text-zinc-500">
          <Link href="/dashboard/admin/users" className="hover:text-zinc-300 underline">manage users →</Link>
        </div>
      )}

      <p className="text-xs text-zinc-600">v{BUILD_VERSION}</p>
    </div>
  )
}
