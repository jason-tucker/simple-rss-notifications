import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { getCurrentUser } from '@/lib/auth/currentUser'
import { AdminUsers, type AdminUser } from '@/components/AdminUsers'
import { PageHeader } from '@/components/ui'

// Reads cookies + DB → never static.
export const dynamic = 'force-dynamic'

export const metadata = { title: 'Users' }

export default async function AdminUsersPage() {
  // React-cache()d — shares the layout's lookup within this request. The
  // admin gate stays here (not in the layout) because layouts persist
  // across client navigation.
  const current = await getCurrentUser()
  if (!current) redirect('/login')
  if (current.user.must_change_password) redirect('/account/password')
  if (!current.user.is_admin) redirect('/')
  const session = current.session

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
