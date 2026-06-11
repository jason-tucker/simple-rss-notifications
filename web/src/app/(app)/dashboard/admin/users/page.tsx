import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { readSessionCookie } from '@/lib/auth/session'
import { AdminUsers, type AdminUser } from '@/components/AdminUsers'
import { PageHeader } from '@/components/ui'

// Reads cookies + DB → never static.
export const dynamic = 'force-dynamic'

export const metadata = { title: 'Users' }

export default async function AdminUsersPage() {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  // Owner-level lookup (no withUser) — needs to read this user's flags and,
  // below, every user row. The admin gate stays here (not in the layout)
  // because layouts persist across client navigation.
  const me = await db.execute<{ is_admin: boolean; must_change_password: boolean; password_changed_at: Date }>(sql`
    SELECT is_admin, must_change_password, password_changed_at FROM users WHERE id = ${session.uid}::uuid LIMIT 1
  `)
  const user = me[0]
  if (!user) redirect('/login')
  if (Math.floor(new Date(user.password_changed_at).getTime() / 1000) > session.iat) redirect('/login')
  if (user.must_change_password) redirect('/account/password')
  if (!user.is_admin) redirect('/')

  const rows = await db.execute<{
    id: string
    username: string
    is_admin: boolean
    must_change_password: boolean
    created_at: Date
  }>(sql`
    SELECT id, username, is_admin, must_change_password, created_at
    FROM users
    ORDER BY created_at ASC, id ASC
  `)

  const users: AdminUser[] = rows.map((u) => ({
    id: u.id,
    username: u.username,
    is_admin: u.is_admin,
    must_change_password: u.must_change_password,
    created_at: new Date(u.created_at).toISOString(),
  }))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Create accounts, grant or revoke admin, reset passwords, or remove users."
      />
      <AdminUsers currentUserId={session.uid} initialUsers={users} />
    </div>
  )
}
