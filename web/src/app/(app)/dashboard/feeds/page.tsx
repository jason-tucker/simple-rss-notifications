import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { FeedRow } from '@/components/FeedRow'
import { ButtonLink, EmptyState, PageHeader } from '@/components/ui'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Feeds' }

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
      <PageHeader
        title="Feeds"
        description="The RSS sources being watched. Connect a feed to a sink with a route to actually get notified."
        action={<ButtonLink variant="primary" size="sm" href="/dashboard/feeds/new">+ Add feed</ButtonLink>}
      />
      {feeds.length === 0 ? (
        <EmptyState
          title="No feeds yet"
          hint="Add an RSS URL and the worker starts watching it within seconds."
          action={<ButtonLink variant="primary" size="sm" href="/dashboard/feeds/new">+ Add feed</ButtonLink>}
        />
      ) : (
        <div className="space-y-2">
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
        </div>
      )}
    </div>
  )
}
