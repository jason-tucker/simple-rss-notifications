import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { readSessionCookie, clearSessionCookie } from '@/lib/auth/session'
import { isSameOrigin } from '@/lib/auth/csrf'
import { hashPassword, verifyPassword } from '@/lib/auth/password'
import { rateLimit, clientIp } from '@/lib/ratelimit'

const Body = z.object({
  current_password: z.string().min(1).max(512),
  new_password: z.string().min(12).max(512),
})

/**
 * Change account password. Reauth-style: requires the CURRENT password
 * in the body even if the user is already logged in, so a hijacked session
 * cookie alone can't rotate the password and lock the legitimate user out.
 *
 * After success:
 *   - update password_hash, password_changed_at, clear must_change_password
 *   - delete ALL web_sessions rows for this user (kills every device)
 *   - clear the current cookie so the user lands back on /login
 *
 * password_changed_at rule in withAuth (any JWT with iat < password_changed_at
 * is rejected) closes the gap for any still-presented JWTs that haven't been
 * lookup-checked since the rotation.
 */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  }
  const session = await readSessionCookie()
  if (!session) {
    return NextResponse.json({ error: 'unauthorized', code: 'no-session' }, { status: 401 })
  }
  const ip = clientIp(req)
  const rl = await rateLimit(`change-pw:user:${session.uid}`, { limit: 5, windowMs: 60_000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate-limited', code: 'rate-limited', retryAfterSec: rl.retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }
  // Per-IP rate limit too, in case multiple session cookies are being pivoted on.
  const ipRl = await rateLimit(`change-pw:ip:${ip}`, { limit: 10, windowMs: 60 * 60_000 })
  if (!ipRl.ok) {
    return NextResponse.json(
      { error: 'rate-limited', code: 'rate-limited', retryAfterSec: ipRl.retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(ipRl.retryAfterSec) } },
    )
  }

  const json = await req.json().catch(() => null)
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad-request', code: 'bad-request', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  // Reject "new == current" up-front to avoid a no-op rotation.
  if (parsed.data.new_password === parsed.data.current_password) {
    return NextResponse.json({ error: 'same-password', code: 'same-password' }, { status: 400 })
  }

  const rows = await db.execute<{ password_hash: string }>(sql`
    SELECT password_hash FROM users WHERE id = ${session.uid}::uuid LIMIT 1
  `)
  const user = rows[0]
  if (!user || !(await verifyPassword(user.password_hash, parsed.data.current_password))) {
    return NextResponse.json({ error: 'invalid-credentials', code: 'invalid-credentials' }, { status: 401 })
  }

  const newHash = await hashPassword(parsed.data.new_password)

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE users SET
        password_hash = ${newHash},
        password_changed_at = now(),
        must_change_password = false,
        updated_at = now()
      WHERE id = ${session.uid}::uuid
    `)
    // Kill every session for this user — current cookie included.
    await tx.execute(sql`DELETE FROM web_sessions WHERE user_id = ${session.uid}::uuid`)
    await tx.execute(sql`
      INSERT INTO audit_log (actor_user_id, action, target_type, target_id, before, after, via, ip)
      VALUES (${session.uid}::uuid, 'change-password', 'user', ${session.uid},
              jsonb_build_object('password', '[REDACTED]'),
              jsonb_build_object('password', '[REDACTED]'),
              'web', ${ip})
    `)
  })

  await clearSessionCookie()
  return NextResponse.json({ ok: true })
}
