import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/lib/db/withUser'
import { readSessionCookie } from '@/lib/auth/session'
import { isSameOrigin } from '@/lib/auth/csrf'
import { sendViaSmtp, sendViaResend } from '@/lib/email/send'
import { publishToNtfy } from '@/lib/ntfy/publish'
import { writeAudit } from '@/lib/audit'
import { rateLimit, clientIp } from '@/lib/ratelimit'

export const dynamic = 'force-dynamic'

const TypeParam = z.enum(['smtp', 'resend', 'ntfy'])

const EmailBody = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200).optional(),
})

const NtfyTestBody = z.object({
  message: z.string().min(1).max(2000).optional(),
})

type Params = { type: string; id: string }

/**
 * Send a one-shot test through the named sink. For SMTP/Resend this is
 * an email; for ntfy it's a push to the sink's configured topic. Rate-
 * limited 10/min/user because each call may cost a real send.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<Params> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { type, id } = await ctx.params
  const typeResult = TypeParam.safeParse(type)
  if (!typeResult.success) return NextResponse.json({ error: 'bad-type' }, { status: 400 })

  const ip = clientIp(req)
  const rl = await rateLimit(`test-send:user:${session.uid}`, { limit: 10, windowMs: 60_000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate-limited', code: 'rate-limited', retryAfterSec: rl.retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  const json = await req.json().catch(() => null)

  // Load sink first (RLS-scoped), then send outside the transaction so
  // a slow network call doesn't pin the DB connection.
  const sink = await withUser(session.uid, async (tx) => {
    const table = typeResult.data === 'smtp' ? sql`sinks_smtp`
                : typeResult.data === 'resend' ? sql`sinks_resend`
                : sql`sinks_ntfy`
    const rows = await tx.execute(sql`SELECT * FROM ${table} WHERE id = ${id}::uuid LIMIT 1`)
    return rows[0] ?? null
  })
  if (!sink) return NextResponse.json({ error: 'not-found' }, { status: 404 })

  const subject = `simple-rss-notifications: test message`
  const text = `This is a test message from your simple-rss-notifications instance.\n\nIf you received this, the sink is configured correctly.\n\n— sent at ${new Date().toISOString()}`

  let result
  let auditAfter: Record<string, unknown>

  if (typeResult.data === 'ntfy') {
    const parsed = NtfyTestBody.safeParse(json ?? {})
    if (!parsed.success) return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
    const message = parsed.data.message ?? text
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result = await publishToNtfy(sink as any, { title: 'Test message', message })
    auditAfter = { ok: result.ok, code: result.code, error: result.error }
  } else {
    const parsed = EmailBody.safeParse(json)
    if (!parsed.success) return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
    const subj = parsed.data.subject ?? subject
    result = typeResult.data === 'smtp'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? await sendViaSmtp(sink as any, { to: parsed.data.to, subject: subj, text })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : await sendViaResend(sink as any, { to: parsed.data.to, subject: subj, text })
    auditAfter = { to: parsed.data.to, ok: result.ok, code: result.code, error: result.error }
  }

  void writeAudit({
    actor_user_id: session.uid,
    action: result.ok ? 'sink.test-send.ok' : 'sink.test-send.failed',
    target_type: typeResult.data === 'smtp' ? 'sink_smtp'
               : typeResult.data === 'resend' ? 'sink_resend'
               : 'sink_ntfy',
    target_id: id,
    after: auditAfter,
    via: 'web',
    ip,
  })

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error, code: result.code }, { status: 502 })
  }
  return NextResponse.json({ ok: true, providerMessageId: result.providerMessageId })
}
