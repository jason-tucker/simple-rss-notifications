import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { withUser } from '@/lib/db/withUser'
import { EditFeedForm } from '@/components/EditFeedForm'

export const dynamic = 'force-dynamic'

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
      has_cookie: boolean
    }>(sql`
      SELECT id, label, url, enabled, poll_interval_s,
             (cookie_ciphertext IS NOT NULL) AS has_cookie
      FROM feeds WHERE id = ${id}::uuid LIMIT 1
    `)
    return rows[0]
  })
  if (!feed) notFound()

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Edit feed</h1>
        <p className="mt-1 text-sm text-zinc-500">
          <Link href="/dashboard/feeds" className="hover:text-zinc-300">← back to feeds</Link>
        </p>
      </header>
      <EditFeedForm initial={feed} />
    </div>
  )
}
