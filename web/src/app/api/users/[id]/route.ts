import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { isSameOrigin } from '@/lib/auth/csrf'
import { requireAdmin, gateError } from '@/lib/auth/admin'
import { hashPassword } from '@/lib/auth/password'
import { writeAudit } from '@/lib/audit'
import { clientIp, rateLimit } from '@/lib/ratelimit'

export const dynamic = 'force-dynamic'

type Params = { id: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PatchBody = z
  .object({
    is_admin: z.boolean().optional(),
    password: z.string().min(8).max(512).optional(),
    must_change_password: z.boolean().optional(),
  })
  .refine(
    (b) => b.is_admin !== undefined || b.password !== undefined || b.must_change_password !== undefined,
    { message: 'no fields to update' },
  )

async function loadTarget(id: string) {
  const rows = await db.execute<{ id: string; username: string; is_admin: boolean }>(sql`
    SELECT id, username, is_admin FROM users WHERE id = ${id}::uuid LIMIT 1
  `)
  return rows[0] ?? null
}

async function adminCount(): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM users WHERE is_admin`)
  return rows[0]?.n ?? 0
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<Params> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })

  const gate = await requireAdmin()
  if (!gate.ok) return gateError(gate)

  const { id } = await ctx.params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'bad-request', code: 'bad-id' }, { status: 400 })

  const rl = await rateLimit(`users:update:${gate.session.uid}`, { limit: 30, windowMs: 60_000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate-limited', code: 'rate-limited', retryAfterSec: rl.retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  const json = await req.json().catch(() => null)
  const parsed = PatchBody.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
  }

  const target = await loadTarget(id)
  if (!target) return NextResponse.json({ error: 'not-found', code: 'not-found' }, { status: 404 })

  // Never let the system lose its last admin: block demoting the only admin.
  if (parsed.data.is_admin === false && target.is_admin && (await adminCount()) <= 1) {
    return NextResponse.json({ error: 'last-admin', code: 'last-admin' }, { status: 400 })
  }

  const sets: SQL[] = []
  if (parsed.data.is_admin !== undefined) sets.push(sql`is_admin = ${parsed.data.is_admin}`)
  if (parsed.data.must_change_password !== undefined) {
    sets.push(sql`must_change_password = ${parsed.data.must_change_password}`)
  }
  if (parsed.data.password !== undefined) {
    const password_hash = await hashPassword(parsed.data.password)
    sets.push(sql`password_hash = ${password_hash}`)
    // Bump password_changed_at so the target's existing JWTs are invalidated
    // (the same revocation channel login/withAuth check against iat).
    sets.push(sql`password_changed_at = now()`)
  }
  sets.push(sql`updated_at = now()`)

  await db.execute(sql`UPDATE users SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid`)

  void writeAudit({
    actor_user_id: gate.session.uid,
    action: 'user.update',
    target_type: 'user',
    target_id: id,
    before: { username: target.username, is_admin: target.is_admin },
    after: {
      is_admin: parsed.data.is_admin,
      must_change_password: parsed.data.must_change_password,
      password: parsed.data.password === undefined ? undefined : '[REDACTED]',
    },
    via: 'web',
    ip: clientIp(req),
  })

  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<Params> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })

  const gate = await requireAdmin()
  if (!gate.ok) return gateError(gate)

  const { id } = await ctx.params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'bad-request', code: 'bad-id' }, { status: 400 })

  const rl = await rateLimit(`users:delete:${gate.session.uid}`, { limit: 20, windowMs: 60_000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate-limited', code: 'rate-limited', retryAfterSec: rl.retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  // Can't delete yourself — avoids an admin nuking their own session/account
  // and the ambiguous "who am I now" state that follows.
  if (id === gate.session.uid) {
    return NextResponse.json({ error: 'cannot-delete-self', code: 'cannot-delete-self' }, { status: 400 })
  }

  const target = await loadTarget(id)
  if (!target) return NextResponse.json({ error: 'not-found', code: 'not-found' }, { status: 404 })

  // Block deleting the last remaining admin.
  if (target.is_admin && (await adminCount()) <= 1) {
    return NextResponse.json({ error: 'last-admin', code: 'last-admin' }, { status: 400 })
  }

  // Deleting a user cascades their feeds/routes/sinks/dispatches/sessions via
  // the ON DELETE CASCADE FKs; audit_log rows keep the action with a NULL actor.
  await db.execute(sql`DELETE FROM users WHERE id = ${id}::uuid`)

  void writeAudit({
    actor_user_id: gate.session.uid,
    action: 'user.delete',
    target_type: 'user',
    target_id: id,
    before: { username: target.username, is_admin: target.is_admin },
    via: 'web',
    ip: clientIp(req),
  })

  return NextResponse.json({ ok: true })
}
