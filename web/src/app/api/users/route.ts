import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { isSameOrigin } from '@/lib/auth/csrf'
import { requireAdmin, gateError } from '@/lib/auth/admin'
import { hashPassword } from '@/lib/auth/password'
import { writeAudit } from '@/lib/audit'
import { clientIp, rateLimit } from '@/lib/ratelimit'

export const dynamic = 'force-dynamic'

// Username is normalized to lowercase (login does the same) and must start
// with an alphanumeric, then allow [a-z0-9._-], 1–64 chars total.
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

const CreateBody = z.object({
  // CLAUDE.md §8 / project default: passwords are .min(8).
  username: z.string().min(1).max(64),
  password: z.string().min(8).max(512),
  is_admin: z.boolean().default(false),
  must_change_password: z.boolean().default(false),
})

/** Extract a Postgres SQLSTATE from a thrown driver error (drizzle may wrap). */
function pgCode(err: unknown): string | undefined {
  if (err && typeof err === 'object') {
    const e = err as { code?: string; cause?: { code?: string } }
    return e.code ?? e.cause?.code
  }
  return undefined
}

export async function GET() {
  const gate = await requireAdmin()
  if (!gate.ok) return gateError(gate)

  const users = await db.execute<{
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

  return NextResponse.json({ users })
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })

  const gate = await requireAdmin()
  if (!gate.ok) return gateError(gate)

  // Creating a user hashes a password (argon2, ~50ms) + writes a row. Cap it.
  const rl = await rateLimit(`users:create:${gate.session.uid}`, { limit: 10, windowMs: 60_000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate-limited', code: 'rate-limited', retryAfterSec: rl.retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  const json = await req.json().catch(() => null)
  const parsed = CreateBody.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
  }

  const username = parsed.data.username.trim().toLowerCase()
  if (!USERNAME_RE.test(username)) {
    return NextResponse.json({ error: 'invalid-username', code: 'invalid-username' }, { status: 400 })
  }

  const password_hash = await hashPassword(parsed.data.password)

  let id: string
  try {
    const rows = await db.execute<{ id: string }>(sql`
      INSERT INTO users (username, password_hash, is_admin, must_change_password)
      VALUES (${username}, ${password_hash}, ${parsed.data.is_admin}, ${parsed.data.must_change_password})
      RETURNING id
    `)
    id = rows[0]!.id
  } catch (err) {
    if (pgCode(err) === '23505') {
      // unique_violation on users.username
      return NextResponse.json({ error: 'username-taken', code: 'username-taken' }, { status: 409 })
    }
    throw err
  }

  void writeAudit({
    actor_user_id: gate.session.uid,
    action: 'user.create',
    target_type: 'user',
    target_id: id,
    after: {
      username,
      is_admin: parsed.data.is_admin,
      must_change_password: parsed.data.must_change_password,
    },
    via: 'web',
    ip: clientIp(req),
  })

  return NextResponse.json({ ok: true, id, username, is_admin: parsed.data.is_admin })
}
