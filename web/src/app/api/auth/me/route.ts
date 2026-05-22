import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { readSessionCookie } from '@/lib/auth/session'

export async function GET() {
  const session = await readSessionCookie()
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 200 })
  }

  const rows = await db.execute<{
    id: string
    username: string
    must_change_password: boolean
    has_reauth_password: boolean
    password_changed_at: Date
  }>(sql`
    SELECT
      id,
      username,
      must_change_password,
      (reauth_password_hash IS NOT NULL) AS has_reauth_password,
      password_changed_at
    FROM users WHERE id = ${session.uid}::uuid LIMIT 1
  `)
  const user = rows[0]
  if (!user) {
    return NextResponse.json({ authenticated: false }, { status: 200 })
  }
  if (Math.floor(new Date(user.password_changed_at).getTime() / 1000) > session.iat) {
    return NextResponse.json({ authenticated: false, reason: 'password-changed' }, { status: 200 })
  }

  return NextResponse.json({
    authenticated: true,
    username: user.username,
    must_change_password: user.must_change_password,
    has_reauth_password: user.has_reauth_password,
    elevated: typeof session.elevatedUntil === 'number' && session.elevatedUntil > Math.floor(Date.now() / 1000),
  })
}
