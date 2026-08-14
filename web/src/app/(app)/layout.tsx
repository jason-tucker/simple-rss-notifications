import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/currentUser'
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
 *
 * getCurrentUser() is React-cache()d, so pages rendering in the same
 * request (e.g. the admin gate) reuse this lookup instead of re-querying.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const current = await getCurrentUser()
  if (!current) redirect('/login')
  const { user } = current
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
