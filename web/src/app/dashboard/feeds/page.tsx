import Link from 'next/link'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { FeedRow } from '@/components/FeedRow'

export const dynamic = 'force-dynamic'

export default async function FeedsPage() {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  const feeds = await withUser(session.uid, async (tx) => {
    return await tx.execute<{
      id: string; label: string; url: string; enabled: boolean
      poll_interval_s: number
      last_polled_at: Date | null; last_success_at: Date | null
      last_error: string | null; last_error_at: Date | null
      consecutive_failures: number
      backfill_mode: string
    }>(sql`
      SELECT id, label, url, enabled, poll_interval_s,
             last_polled_at, last_success_at, last_error, last_error_at,
             consecutive_failures, backfill_mode
      FROM feeds ORDER BY created_at
    `)
  })

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Feeds</h1>
        <Link href="/dashboard/feeds/new" className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">+ New feed</Link>
      </header>
      <p className="text-sm text-zinc-400">
        RSS sources the worker polls. Pair a feed with a sink via a{' '}
        <Link href="/dashboard/routes" className="underline hover:text-zinc-200">route</Link>{' '}
        to actually send notifications.
      </p>
      {feeds.length === 0 ? (
        <div className="rounded border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-500">
          No feeds yet. Add one above.
        </div>
      ) : (
        <ul className="space-y-2">
          {feeds.map((f) => (
            <FeedRow key={f.id} feed={{
              id: f.id, label: f.label, url: f.url, enabled: f.enabled,
              poll_interval_s: f.poll_interval_s,
              last_polled_at: f.last_polled_at ? new Date(f.last_polled_at).toISOString() : null,
              last_success_at: f.last_success_at ? new Date(f.last_success_at).toISOString() : null,
              last_error: f.last_error,
              consecutive_failures: f.consecutive_failures,
              backfill_mode: f.backfill_mode,
            }} />
          ))}
        </ul>
      )}
      <p className="text-xs text-zinc-600">
        <Link href="/" className="hover:text-zinc-400">← back to dashboard</Link>
      </p>
    </div>
  )
}
