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

/** Thrown inside a transaction to roll it back and signal a last-admin block. */
class LastAdminError extends Error {}

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

  // Can't demote yourself — mirrors the self-delete guard, and avoids the
  // confusing "I removed my own admin and got bounced out of this page" state.
  // Another admin has to demote you.
  if (id === gate.session.uid && parsed.data.is_admin === false) {
    return NextResponse.json({ error: 'cannot-demote-self', code: 'cannot-demote-self' }, { status: 400 })
  }

  // Hash before opening the transaction so argon2 (~50ms) doesn't hold the
  // admin-row lock.
  const password_hash =
    parsed.data.password === undefined ? undefined : await hashPassword(parsed.data.password)

  try {
    await db.transaction(async (tx) => {
      // Lock every admin row up front so concurrent demotes/deletes serialize.
      // Without it, two requests can both see count > 1 and both demote, dropping
      // the system to zero admins (a TOCTOU race). count(*) can't take FOR
      // UPDATE, so we lock the rows themselves and count them.
      const admins = await tx.execute<{ id: string }>(sql`SELECT id FROM users WHERE is_admin FOR UPDATE`)
      const removesLastAdmin =
        parsed.data.is_admin === false && admins.length <= 1 && admins.some((a) => a.id === id)
      if (removesLastAdmin) throw new LastAdminError()

      const sets: SQL[] = []
      if (parsed.data.is_admin !== undefined) sets.push(sql`is_admin = ${parsed.data.is_admin}`)
      if (parsed.data.must_change_password !== undefined) {
        sets.push(sql`must_change_password = ${parsed.data.must_change_password}`)
      }
      if (password_hash !== undefined) {
        sets.push(sql`password_hash = ${password_hash}`)
        // Bump password_changed_at so the target's existing JWTs are invalidated
        // (the same revocation channel login/withAuth check against iat).
        sets.push(sql`password_changed_at = now()`)
      }
      sets.push(sql`updated_at = now()`)

      await tx.execute(sql`UPDATE users SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid`)

      // An admin password reset must force the target fully out: bumping
      // password_changed_at invalidates JWTs issued before now, but stale
      // jti rows would otherwise survive. Kill every session for the target
      // in the same txn (mirrors the self-service change-password route).
      if (password_hash !== undefined) {
        await tx.execute(sql`DELETE FROM web_sessions WHERE user_id = ${id}::uuid`)
      }
    })
  } catch (err) {
    if (err instanceof LastAdminError) {
      return NextResponse.json({ error: 'last-admin', code: 'last-admin' }, { status: 400 })
    }
    throw err
  }

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

  // Deleting a user cascades their feeds/routes/sinks/dispatches/sessions via
  // the ON DELETE CASCADE FKs; audit_log rows keep the action with a NULL actor.
  // Lock the admin rows + recheck inside the txn so concurrent deletes can't
  // race the last admin away (same TOCTOU guard as PATCH).
  try {
    await db.transaction(async (tx) => {
      const admins = await tx.execute<{ id: string }>(sql`SELECT id FROM users WHERE is_admin FOR UPDATE`)
      const removesLastAdmin = admins.length <= 1 && admins.some((a) => a.id === id)
      if (removesLastAdmin) throw new LastAdminError()
      await tx.execute(sql`DELETE FROM users WHERE id = ${id}::uuid`)
    })
  } catch (err) {
    if (err instanceof LastAdminError) {
      return NextResponse.json({ error: 'last-admin', code: 'last-admin' }, { status: 400 })
    }
    throw err
  }

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
