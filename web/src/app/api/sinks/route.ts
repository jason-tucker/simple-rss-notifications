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

/**
 * GET  /api/sinks       → list all sinks for the current user, secrets redacted
 * POST /api/sinks       → create a new SMTP or Resend sink
 *
 * Per-item edit and delete live at /api/sinks/[type]/[id].
 *
 * Returned sink rows NEVER include the encrypted ciphertext. Callers see
 * only: type, id, label, public connection fields, incomplete flag,
 * has_secret (boolean), timestamps.
 */

interface ListedSink {
  type: 'smtp' | 'resend'
  id: string
  label: string
  from_email: string
  from_name: string | null
  host?: string
  port?: number
  username?: string
  use_tls?: boolean
  incomplete: boolean
  has_secret: boolean
  created_at: string
  updated_at: string
}

export async function GET() {
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  return withUser(session.uid, async (tx) => {
    const smtp = await tx.execute<{
      id: string; label: string; host: string; port: number; username: string
      from_email: string; from_name: string | null; use_tls: boolean
      incomplete: boolean; has_secret: boolean
      created_at: Date; updated_at: Date
    }>(sql`
      SELECT id, label, host, port, username, from_email, from_name, use_tls,
             incomplete, (password_ciphertext IS NOT NULL) AS has_secret,
             created_at, updated_at
      FROM sinks_smtp ORDER BY created_at
    `)
    const resend = await tx.execute<{
      id: string; label: string; from_email: string; from_name: string | null
      incomplete: boolean; has_secret: boolean
      created_at: Date; updated_at: Date
    }>(sql`
      SELECT id, label, from_email, from_name,
             incomplete, (api_key_ciphertext IS NOT NULL) AS has_secret,
             created_at, updated_at
      FROM sinks_resend ORDER BY created_at
    `)
    const out: ListedSink[] = [
      ...smtp.map((s) => ({
        type: 'smtp' as const,
        id: s.id, label: s.label, host: s.host, port: s.port, username: s.username,
        from_email: s.from_email, from_name: s.from_name, use_tls: s.use_tls,
        incomplete: s.incomplete, has_secret: s.has_secret,
        created_at: new Date(s.created_at).toISOString(),
        updated_at: new Date(s.updated_at).toISOString(),
      })),
      ...resend.map((s) => ({
        type: 'resend' as const,
        id: s.id, label: s.label,
        from_email: s.from_email, from_name: s.from_name,
        incomplete: s.incomplete, has_secret: s.has_secret,
        created_at: new Date(s.created_at).toISOString(),
        updated_at: new Date(s.updated_at).toISOString(),
      })),
    ]
    return NextResponse.json({ sinks: out })
  })
}

const SmtpBody = z.object({
  type: z.literal('smtp'),
  label: z.string().min(1).max(100),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(1024).optional(), // blank = create incomplete
  from_email: z.string().email(),
  from_name: z.string().max(100).optional().nullable(),
  use_tls: z.boolean().default(true),
})

const ResendBody = z.object({
  type: z.literal('resend'),
  label: z.string().min(1).max(100),
  api_key: z.string().min(1).max(1024).optional(),
  from_email: z.string().email(),
  from_name: z.string().max(100).optional().nullable(),
})

const Body = z.discriminatedUnion('type', [SmtpBody, ResendBody])

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const json = await req.json().catch(() => null)
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
  }
  const ip = clientIp(req)

  return withUser(session.uid, async (tx) => {
    if (parsed.data.type === 'smtp') {
      const enc = parsed.data.password ? encrypt(parsed.data.password) : null
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO sinks_smtp (
          user_id, label, host, port, username,
          password_ciphertext, password_iv, password_tag, password_key_version,
          from_email, from_name, use_tls, incomplete
        )
        VALUES (
          ${session.uid}::uuid, ${parsed.data.label}, ${parsed.data.host}, ${parsed.data.port}, ${parsed.data.username},
          ${enc?.ciphertext ?? null}, ${enc?.iv ?? null}, ${enc?.tag ?? null}, ${enc?.keyVersion ?? null},
          ${parsed.data.from_email}, ${parsed.data.from_name ?? null}, ${parsed.data.use_tls}, ${!enc}
        )
        RETURNING id
      `)
      const id = rows[0]!.id
      void writeAudit({
        actor_user_id: session.uid,
        action: 'sink.create',
        target_type: 'sink_smtp',
        target_id: id,
        after: redactSecretFields(parsed.data, ['password']),
        via: 'web',
        ip,
      })
      return NextResponse.json({ ok: true, id, type: 'smtp' })
    } else {
      const enc = parsed.data.api_key ? encrypt(parsed.data.api_key) : null
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO sinks_resend (
          user_id, label,
          api_key_ciphertext, api_key_iv, api_key_tag, api_key_key_version,
          from_email, from_name, incomplete
        )
        VALUES (
          ${session.uid}::uuid, ${parsed.data.label},
          ${enc?.ciphertext ?? null}, ${enc?.iv ?? null}, ${enc?.tag ?? null}, ${enc?.keyVersion ?? null},
          ${parsed.data.from_email}, ${parsed.data.from_name ?? null}, ${!enc}
        )
        RETURNING id
      `)
      const id = rows[0]!.id
      void writeAudit({
        actor_user_id: session.uid,
        action: 'sink.create',
        target_type: 'sink_resend',
        target_id: id,
        after: redactSecretFields(parsed.data, ['api_key']),
        via: 'web',
        ip,
      })
      return NextResponse.json({ ok: true, id, type: 'resend' })
    }
  })
}
