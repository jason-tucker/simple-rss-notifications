import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { verifyPassword } from '@/lib/auth/password'
import { mintSession, newJti, setSessionCookie, SESSION_TTL_SECONDS } from '@/lib/auth/session'
import { isSameOrigin } from '@/lib/auth/csrf'
import { rateLimitAll, clientIp } from '@/lib/ratelimit'

const Body = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(512),
})

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  }

  // Rate limit BEFORE password check so a brute-forcer can't even burn CPU on hashes.
  const ip = clientIp(req)
  const json = await req.json().catch(() => null)
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', code: 'bad-request' }, { status: 400 })
  }
  const username = parsed.data.username.trim().toLowerCase()

  const rl = await rateLimitAll([
    { key: `login:ip:${ip}`, opts: { limit: 5, windowMs: 60_000 } },
    { key: `login:user:${username}`, opts: { limit: 10, windowMs: 60 * 60_000 } },
  ])
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate-limited', code: 'rate-limited', retryAfterSec: rl.retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  // Look up user + verify password. Same generic 401 either way to avoid
  // username-enumeration. We still do the argon2 hash work on a dummy hash
  // when the user doesn't exist, so timing doesn't leak existence either.
  const rows = await db.execute<{ id: string; password_hash: string; must_change_password: boolean; username: string }>(sql`
    SELECT id, password_hash, must_change_password, username FROM users WHERE username = ${username} LIMIT 1
  `)
  const user = rows[0]

  // Burn a comparable amount of CPU on unknown users by verifying against a
  // throwaway argon2 hash. The fixed string is intentionally hardcoded — the
  // dummy hash format must be valid argon2id; the secret doesn't matter.
  const DUMMY = '$argon2id$v=19$m=19456,t=2,p=1$Y2hhbmdlbWVjaGFuZ2VtZQ$6Bv7TpA2gC9o2lqgvfTNvD0nF6JhT5T0H7gqQwjV4o0'
  const ok = user
    ? await verifyPassword(user.password_hash, parsed.data.password)
    : (await verifyPassword(DUMMY, parsed.data.password), false)

  if (!user || !ok) {
    return NextResponse.json({ error: 'invalid-credentials', code: 'invalid-credentials' }, { status: 401 })
  }

  // Mint JWT + mirror jti into web_sessions.
  const jti = newJti()
  const token = await mintSession({ jti, uid: user.id, username: user.username })

  const ua = req.headers.get('user-agent') ?? null
  await db.execute(sql`
    INSERT INTO web_sessions (jti, user_id, issued_at, expires_at, user_agent, ip)
    VALUES (${jti}, ${user.id}::uuid, now(), now() + (${SESSION_TTL_SECONDS}::int * interval '1 second'), ${ua}, ${ip})
  `)

  await setSessionCookie(token)

  return NextResponse.json({
    ok: true,
    must_change_password: user.must_change_password,
    username: user.username,
  })
}
