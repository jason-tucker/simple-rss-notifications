import { redirect } from 'next/navigation'
import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { RouteForm } from '@/components/RouteForm'
import { Callout, PageHeader } from '@/components/ui'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'New route' }

export default async function NewRoutePage() {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  const { feeds, sinks } = await withUser(session.uid, async (tx) => {
    const feeds = await tx.execute<{ id: string; label: string; enabled: boolean }>(sql`
      SELECT id, label, enabled FROM feeds ORDER BY label
    `)
    const smtp = await tx.execute<{ id: string; label: string; incomplete: boolean }>(sql`
      SELECT id, label, incomplete FROM sinks_smtp ORDER BY label
    `)
    const resend = await tx.execute<{ id: string; label: string; incomplete: boolean }>(sql`
      SELECT id, label, incomplete FROM sinks_resend ORDER BY label
    `)
    const ntfy = await tx.execute<{ id: string; label: string; incomplete: boolean; topic: string }>(sql`
      SELECT id, label, incomplete, topic FROM sinks_ntfy ORDER BY label
    `)
    const discord = await tx.execute<{ id: string; label: string; incomplete: boolean }>(sql`
      SELECT id, label, incomplete FROM sinks_discord_webhook ORDER BY label
    `)
    return {
      feeds,
      sinks: [
        ...smtp.map((s) => ({ ...s, type: 'smtp' as const, topic: null as string | null })),
        ...resend.map((s) => ({ ...s, type: 'resend' as const, topic: null as string | null })),
        ...ntfy.map((s) => ({ ...s, type: 'ntfy' as const })),
        ...discord.map((s) => ({ ...s, type: 'discord_webhook' as const, topic: null as string | null })),
      ],
    }
  })

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title="New route" description="Pick a feed, then choose where its new items should go." />

      {feeds.length === 0 || sinks.length === 0 ? (
        <Callout tone="warn">
          {feeds.length === 0 && (<>You need at least one <Link href="/dashboard/feeds/new" className="underline">feed</Link>. </>)}
          {sinks.length === 0 && (<>You need at least one <Link href="/dashboard/sinks/new" className="underline">sink</Link>.</>)}
        </Callout>
      ) : (
        <RouteForm mode="new" feeds={feeds} sinks={sinks} />
      )}
    </div>
  )
}
