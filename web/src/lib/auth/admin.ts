import 'server-only'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { readSessionCookie, type Session } from './session'

/**
 * Admin gate for routes and server pages.
 *
 * The lookup runs as the DB OWNER (no `withUser` / no `SET LOCAL ROLE`), so it
 * can read any user row — the same owner-level access the login route uses.
 * It also re-checks `password_changed_at > iat` so a stale JWT issued before a
 * password change can't keep admin access (mirrors what HomePage does).
 *
 * Usage in an API route:
 *   const gate = await requireAdmin()
 *   if (!gate.ok) return gateError(gate)
 *   // gate.session is the authenticated admin
 */
export type AdminGate =
  | { ok: true; session: Session }
  | { ok: false; status: 401 | 403; code: 'no-session' | 'user-missing' | 'password-changed' | 'not-admin' }

export async function requireAdmin(): Promise<AdminGate> {
  const session = await readSessionCookie()
  if (!session) return { ok: false, status: 401, code: 'no-session' }

  const rows = await db.execute<{ is_admin: boolean; password_changed_at: Date }>(sql`
    SELECT is_admin, password_changed_at FROM users WHERE id = ${session.uid}::uuid LIMIT 1
  `)
  const row = rows[0]
  if (!row) return { ok: false, status: 401, code: 'user-missing' }
  if (Math.floor(new Date(row.password_changed_at).getTime() / 1000) > session.iat) {
    return { ok: false, status: 401, code: 'password-changed' }
  }
  if (!row.is_admin) return { ok: false, status: 403, code: 'not-admin' }

  return { ok: true, session }
}

/** Turn a failed gate into the canonical JSON error response. */
export function gateError(gate: Extract<AdminGate, { ok: false }>): NextResponse {
  return NextResponse.json(
    { error: gate.status === 403 ? 'forbidden' : 'unauthorized', code: gate.code },
    { status: gate.status },
  )
}

/**
 * Is the user with `userId` an admin? Cheap owner-level lookup for server
 * pages that already have a session and just need the boolean (e.g. to show
 * or hide the admin nav link). Returns false for a missing user.
 */
export async function isAdmin(userId: string): Promise<boolean> {
  const rows = await db.execute<{ is_admin: boolean }>(sql`
    SELECT is_admin FROM users WHERE id = ${userId}::uuid LIMIT 1
  `)
  return rows[0]?.is_admin === true
}
