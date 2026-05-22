import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/lib/db/withUser'
import { readSessionCookie } from '@/lib/auth/session'
import { isSameOrigin } from '@/lib/auth/csrf'
import { sendViaSmtp, sendViaResend } from '@/lib/email/send'
import { writeAudit } from '@/lib/audit'
import { rateLimit, clientIp } from '@/lib/ratelimit'

export const dynamic = 'force-dynamic'

const TypeParam = z.enum(['smtp', 'resend'])
const Body = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200).optional(),
})

type Params = { type: string; id: string }

/**
 * Send a one-shot test email through the named sink. Rate-limited 10/min
 * per user because each call costs a real email and may hit provider quota.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<Params> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { type, id } = await ctx.params
  const typeResult = TypeParam.safeParse(type)
  if (!typeResult.success) return NextResponse.json({ error: 'bad-type' }, { status: 400 })

  const json = await req.json().catch(() => null)
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
  }
  const ip = clientIp(req)

  const rl = await rateLimit(`test-send:user:${session.uid}`, { limit: 10, windowMs: 60_000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate-limited', code: 'rate-limited', retryAfterSec: rl.retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  const subject = parsed.data.subject ?? `simple-rss-notifications: test message`
  const text = `This is a test message from your simple-rss-notifications instance.\n\nIf you received this, the sink is configured correctly.\n\n— sent at ${new Date().toISOString()}`

  // Load the sink (RLS-scoped via withUser), then send OUTSIDE the
  // transaction so an SMTP timeout doesn't hold the DB connection.
  const sink = await withUser(session.uid, async (tx) => {
    if (typeResult.data === 'smtp') {
      const rows = await tx.execute(sql`SELECT * FROM sinks_smtp WHERE id = ${id}::uuid LIMIT 1`)
      return rows[0] ?? null
    }
    const rows = await tx.execute(sql`SELECT * FROM sinks_resend WHERE id = ${id}::uuid LIMIT 1`)
    return rows[0] ?? null
  })

  if (!sink) return NextResponse.json({ error: 'not-found' }, { status: 404 })

  const result = typeResult.data === 'smtp'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? await sendViaSmtp(sink as any, { to: parsed.data.to, subject, text })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : await sendViaResend(sink as any, { to: parsed.data.to, subject, text })

  void writeAudit({
    actor_user_id: session.uid,
    action: result.ok ? 'sink.test-send.ok' : 'sink.test-send.failed',
    target_type: typeResult.data === 'smtp' ? 'sink_smtp' : 'sink_resend',
    target_id: id,
    after: { to: parsed.data.to, ok: result.ok, code: result.code, error: result.error },
    via: 'web',
    ip,
  })

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error, code: result.code }, { status: 502 })
  }
  return NextResponse.json({ ok: true, providerMessageId: result.providerMessageId })
}
