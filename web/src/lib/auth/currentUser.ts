import 'server-only'
import { cache } from 'react'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { readSessionCookie, type Session } from '@/lib/auth/session'

export interface CurrentUser {
  session: Session
  user: {
    id: string
    username: string
    is_admin: boolean
    must_change_password: boolean
  }
}

/**
 * Session + user row for the current request, memoized with React
 * cache() so the (app) layout and any page/nested component rendering in
 * the same request share ONE users-table query instead of repeating it.
 *
 * Returns null when there is no session, the user row is gone, or the
 * password changed after the JWT was minted (stale session). No
 * redirects here — callers decide (layout → /login | /account/password,
 * admin page additionally → / for non-admins).
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await readSessionCookie()
  if (!session) return null

  const rows = await db.execute<{
    username: string
    is_admin: boolean
    must_change_password: boolean
    password_changed_at: Date
  }>(sql`
    SELECT username, is_admin, must_change_password, password_changed_at
    FROM users WHERE id = ${session.uid}::uuid LIMIT 1
  `)
  const row = rows[0]
  if (!row) return null
  if (Math.floor(new Date(row.password_changed_at).getTime() / 1000) > session.iat) return null

  return {
    session,
    user: {
      id: session.uid,
      username: row.username,
      is_admin: row.is_admin,
      must_change_password: row.must_change_password,
    },
  }
})
