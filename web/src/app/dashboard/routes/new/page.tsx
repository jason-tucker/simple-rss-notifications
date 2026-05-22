import { redirect } from 'next/navigation'
import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { NewRouteForm } from '@/components/NewRouteForm'

export const dynamic = 'force-dynamic'

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
    return {
      feeds,
      sinks: [
        ...smtp.map((s) => ({ ...s, type: 'smtp' as const, topic: null as string | null })),
        ...resend.map((s) => ({ ...s, type: 'resend' as const, topic: null as string | null })),
        ...ntfy.map((s) => ({ ...s, type: 'ntfy' as const })),
      ],
    }
  })

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">New route</h1>
        <p className="mt-1 text-sm text-zinc-500">
          <Link href="/dashboard/routes" className="hover:text-zinc-300">← back to routes</Link>
        </p>
      </header>

      {feeds.length === 0 || sinks.length === 0 ? (
        <div className="rounded border border-amber-700 bg-amber-950 p-4 text-sm text-amber-200">
          {feeds.length === 0 && (<>You need at least one <Link href="/dashboard/feeds/new" className="underline">feed</Link>. </>)}
          {sinks.length === 0 && (<>You need at least one <Link href="/dashboard/sinks/new?type=smtp" className="underline">sink</Link>.</>)}
        </div>
      ) : (
        <NewRouteForm feeds={feeds} sinks={sinks} />
      )}
    </div>
  )
}
