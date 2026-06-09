import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { withAuth } from '@/lib/auth/withAuth'
import { withUser } from '@/lib/db/withUser'
import { sendViaSmtp, sendViaResend } from '@/lib/email/send'
import { publishToNtfy } from '@/lib/ntfy/publish'
import { publishToDiscord } from '@/lib/discord/webhook'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

const TypeParam = z.enum(['smtp', 'resend', 'ntfy', 'discord_webhook'])

const EmailBody = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200).optional(),
})

const NtfyTestBody = z.object({
  message: z.string().min(1).max(2000).optional(),
})

const DiscordTestBody = z.object({
  message: z.string().min(1).max(2000).optional(),
})

/**
 * Send a one-shot test through the named sink. For SMTP/Resend this is
 * an email; for ntfy it's a push to the sink's configured topic. Rate-
 * limited 10/min/user (via withAuth) because each call may cost a real send.
 */
export const POST = withAuth(
  async (req, { session, ip }, route) => {
    const { type, id } = await route.params
    const typeResult = TypeParam.safeParse(type)
    if (!typeResult.success) return NextResponse.json({ error: 'bad-type' }, { status: 400 })

    const json = await req.json().catch(() => null)

    // Load sink first (RLS-scoped), then send outside the transaction so
    // a slow network call doesn't pin the DB connection.
    const sink = await withUser(session.uid, async (tx) => {
      const table = typeResult.data === 'smtp' ? sql`sinks_smtp`
                  : typeResult.data === 'resend' ? sql`sinks_resend`
                  : typeResult.data === 'ntfy' ? sql`sinks_ntfy`
                  : sql`sinks_discord_webhook`
      const rows = await tx.execute(sql`SELECT * FROM ${table} WHERE id = ${id}::uuid LIMIT 1`)
      return rows[0] ?? null
    })
    if (!sink) return NextResponse.json({ error: 'not-found' }, { status: 404 })

    const subject = `Euphoric Notify: test message`
    const text = `This is a test message from your Euphoric Notify instance.\n\nIf you received this, the sink is configured correctly.\n\n— sent at ${new Date().toISOString()}`

    let result
    let auditAfter: Record<string, unknown>

    if (typeResult.data === 'ntfy') {
      const parsed = NtfyTestBody.safeParse(json ?? {})
      if (!parsed.success) return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
      const message = parsed.data.message ?? text
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = await publishToNtfy(sink as any, { title: 'Test message', message })
      auditAfter = { ok: result.ok, code: result.code, error: result.error }
    } else if (typeResult.data === 'discord_webhook') {
      const parsed = DiscordTestBody.safeParse(json ?? {})
      if (!parsed.success) return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
      const message = parsed.data.message ?? text
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = await publishToDiscord(sink as any, { title: 'Test message', message })
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
                 : typeResult.data === 'ntfy' ? 'sink_ntfy'
                 : 'sink_discord_webhook',
      target_id: id,
      after: auditAfter,
      via: 'web',
      ip,
    })

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error, code: result.code }, { status: 502 })
    }
    return NextResponse.json({ ok: true, providerMessageId: result.providerMessageId })
  },
  { rateLimitPerUser: { limit: 10, windowMs: 60_000 } },
)
