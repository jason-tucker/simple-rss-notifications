import { redirect, notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { EditFeedForm } from '@/components/EditFeedForm'
import { PageHeader } from '@/components/ui'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Edit feed' }

export default async function EditFeedPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await readSessionCookie()
  if (!session) redirect('/login')
  const { id } = await params

  const feed = await withUser(session.uid, async (tx) => {
    const rows = await tx.execute<{
      id: string; label: string; url: string; enabled: boolean; poll_interval_s: number
    }>(sql`
      SELECT id, label, url, enabled, poll_interval_s FROM feeds WHERE id = ${id}::uuid LIMIT 1
    `)
    return rows[0]
  })
  if (!feed) notFound()

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader title="Edit feed" description={feed.label} />
      <EditFeedForm initial={feed} />
    </div>
  )
}
