import Link from 'next/link'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { readSessionCookie } from '@/lib/auth/session'
import { Brand } from '@/components/Brand'
import { Nav } from '@/components/Nav'
import { LogoutButton } from '@/components/LogoutButton'

// Reads cookies + DB → never static.
export const dynamic = 'force-dynamic'

/**
 * Shared shell for every signed-in page: header with brand, nav, and the
 * signed-in user. Also runs the session sanity checks (stale password,
 * forced password change) once for the whole group. Note layouts persist
 * across client-side navigation, so these checks are a UX gate — the real
 * security boundary stays in withAuth() on the API routes.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  const rows = await db.execute<{
    username: string
    is_admin: boolean
    must_change_password: boolean
    password_changed_at: Date
  }>(sql`
    SELECT username, is_admin, must_change_password, password_changed_at
    FROM users WHERE id = ${session.uid}::uuid LIMIT 1
  `)
  const user = rows[0]
  if (!user) redirect('/login')
  if (Math.floor(new Date(user.password_changed_at).getTime() / 1000) > session.iat) redirect('/login')
  if (user.must_change_password) redirect('/account/password')

  return (
    <div className="flex-1">
      <header className="border-b border-zinc-800/80">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 pt-3">
          <Link href="/" className="shrink-0">
            <Brand />
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-zinc-500 sm:inline">{user.username}</span>
            <LogoutButton />
          </div>
        </div>
        <div className="mx-auto max-w-4xl px-4 py-2">
          <Nav isAdmin={user.is_admin} />
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl px-4 py-8">{children}</main>
    </div>
  )
}
