import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/lib/db/withUser'
import { readSessionCookie } from '@/lib/auth/session'
import { isSameOrigin } from '@/lib/auth/csrf'
import { encrypt } from '@/lib/crypto/aead'
import { writeAudit, redactSecretFields } from '@/lib/audit'
import { clientIp } from '@/lib/ratelimit'

export const dynamic = 'force-dynamic'

const TypeParam = z.enum(['smtp', 'resend'])

const SmtpPatch = z.object({
  label: z.string().min(1).max(100).optional(),
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1).max(255).optional(),
  /** Blank/omitted = keep current password. A non-empty string rotates it. */
  password: z.string().max(1024).optional(),
  from_email: z.string().email().optional(),
  from_name: z.string().max(100).nullable().optional(),
  use_tls: z.boolean().optional(),
})

const ResendPatch = z.object({
  label: z.string().min(1).max(100).optional(),
  api_key: z.string().max(1024).optional(),
  from_email: z.string().email().optional(),
  from_name: z.string().max(100).nullable().optional(),
})

type Params = { type: string; id: string }

export async function PATCH(req: NextRequest, ctx: { params: Promise<Params> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { type, id } = await ctx.params
  const typeResult = TypeParam.safeParse(type)
  if (!typeResult.success) return NextResponse.json({ error: 'bad-type' }, { status: 400 })

  const json = await req.json().catch(() => null)
  const ip = clientIp(req)

  if (typeResult.data === 'smtp') {
    const parsed = SmtpPatch.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
    }
    return withUser(session.uid, async (tx) => {
      // RLS scopes this UPDATE to rows owned by the current user automatically.
      const enc = parsed.data.password && parsed.data.password.length > 0 ? encrypt(parsed.data.password) : null
      const rows = await tx.execute<{ id: string }>(sql`
        UPDATE sinks_smtp SET
          label        = COALESCE(${parsed.data.label ?? null},        label),
          host         = COALESCE(${parsed.data.host ?? null},         host),
          port         = COALESCE(${parsed.data.port ?? null},         port),
          username     = COALESCE(${parsed.data.username ?? null},     username),
          from_email   = COALESCE(${parsed.data.from_email ?? null},   from_email),
          from_name    = ${parsed.data.from_name === undefined ? sql`from_name` : sql`${parsed.data.from_name}`},
          use_tls      = COALESCE(${parsed.data.use_tls ?? null},      use_tls),
          password_ciphertext  = COALESCE(${enc?.ciphertext ?? null},  password_ciphertext),
          password_iv          = COALESCE(${enc?.iv ?? null},          password_iv),
          password_tag         = COALESCE(${enc?.tag ?? null},         password_tag),
          password_key_version = COALESCE(${enc?.keyVersion ?? null},  password_key_version),
          incomplete   = CASE WHEN ${enc !== null} OR password_ciphertext IS NOT NULL THEN false ELSE incomplete END,
          updated_at   = now()
        WHERE id = ${id}::uuid
        RETURNING id
      `)
      if (!rows[0]) return NextResponse.json({ error: 'not-found' }, { status: 404 })
      void writeAudit({
        actor_user_id: session.uid,
        action: 'sink.update',
        target_type: 'sink_smtp',
        target_id: id,
        after: redactSecretFields(parsed.data, ['password']),
        via: 'web',
        ip,
      })
      return NextResponse.json({ ok: true })
    })
  }

  // type === 'resend'
  const parsed = ResendPatch.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
  }
  return withUser(session.uid, async (tx) => {
    const enc = parsed.data.api_key && parsed.data.api_key.length > 0 ? encrypt(parsed.data.api_key) : null
    const rows = await tx.execute<{ id: string }>(sql`
      UPDATE sinks_resend SET
        label      = COALESCE(${parsed.data.label ?? null},      label),
        from_email = COALESCE(${parsed.data.from_email ?? null}, from_email),
        from_name  = ${parsed.data.from_name === undefined ? sql`from_name` : sql`${parsed.data.from_name}`},
        api_key_ciphertext  = COALESCE(${enc?.ciphertext ?? null},  api_key_ciphertext),
        api_key_iv          = COALESCE(${enc?.iv ?? null},          api_key_iv),
        api_key_tag         = COALESCE(${enc?.tag ?? null},         api_key_tag),
        api_key_key_version = COALESCE(${enc?.keyVersion ?? null},  api_key_key_version),
        incomplete = CASE WHEN ${enc !== null} OR api_key_ciphertext IS NOT NULL THEN false ELSE incomplete END,
        updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING id
    `)
    if (!rows[0]) return NextResponse.json({ error: 'not-found' }, { status: 404 })
    void writeAudit({
      actor_user_id: session.uid,
      action: 'sink.update',
      target_type: 'sink_resend',
      target_id: id,
      after: redactSecretFields(parsed.data, ['api_key']),
      via: 'web',
      ip,
    })
    return NextResponse.json({ ok: true })
  })
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<Params> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { type, id } = await ctx.params
  const typeResult = TypeParam.safeParse(type)
  if (!typeResult.success) return NextResponse.json({ error: 'bad-type' }, { status: 400 })

  const ip = clientIp(req)
  const table = typeResult.data === 'smtp' ? sql`sinks_smtp` : sql`sinks_resend`
  return withUser(session.uid, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`DELETE FROM ${table} WHERE id = ${id}::uuid RETURNING id`)
    if (!rows[0]) return NextResponse.json({ error: 'not-found' }, { status: 404 })
    void writeAudit({
      actor_user_id: session.uid,
      action: 'sink.delete',
      target_type: typeResult.data === 'smtp' ? 'sink_smtp' : 'sink_resend',
      target_id: id,
      via: 'web',
      ip,
    })
    return NextResponse.json({ ok: true })
  })
}
