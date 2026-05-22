import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { readSessionCookie } from '@/lib/auth/session'
import { BUILD_VERSION } from '@/lib/version'
import { LogoutButton } from '@/components/LogoutButton'

// Reading cookies + DB inside the page means this must be dynamic — no static
// rendering. (Next 15 would error out if it tried to statically render this.)
export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  const rows = await db.execute<{ must_change_password: boolean; password_changed_at: Date; username: string }>(sql`
    SELECT must_change_password, password_changed_at, username FROM users WHERE id = ${session.uid}::uuid LIMIT 1
  `)
  const user = rows[0]
  if (!user) redirect('/login')
  if (Math.floor(new Date(user.password_changed_at).getTime() / 1000) > session.iat) redirect('/login')
  if (user.must_change_password) redirect('/account/password')

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">simple-rss-notifications</h1>
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <span>Signed in as <span className="text-zinc-200">{user.username}</span></span>
          <LogoutButton />
        </div>
      </header>
      <p className="text-zinc-400">
        RSS → email / ntfy bridge. Configure everything in the UI — no server-side
        config files, no restarts on change.
      </p>
      <div className="rounded border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-400">
        v{BUILD_VERSION} — auth landed in PR3. Feeds, routes, sinks, and the
        worker dashboard arrive in PR5–PR10.
      </div>
    </div>
  )
}
