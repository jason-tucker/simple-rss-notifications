import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { isSameOrigin } from '@/lib/auth/csrf'
import { withUser } from '@/lib/db/withUser'
import { writeAudit } from '@/lib/audit'
import { rateLimit, clientIp } from '@/lib/ratelimit'
import { sendViaSmtp, sendViaResend } from '@/lib/email/send'
import { publishToNtfy } from '@/lib/ntfy/publish'
import { publishToDiscord } from '@/lib/discord/webhook'
import type { SinkSmtp, SinkResend, SinkNtfy, SinkDiscordWebhook } from '@/lib/db/schema'

export const dynamic = 'force-dynamic'

type Params = { id: string; destId: string }

/**
 * Manual one-shot test: send the most recent feed_item from the route's
 * feed through this destination's sink. Same formatting the dispatcher
 * would use — title, summary, link — so the user can see the real-shape
 * notification before waiting for the next poll cycle.
 *
 * Intentionally does NOT record a dispatches row:
 *   - It's a TEST, not a delivery. The destination is supposed to keep
 *     dispatching the same item again later if/when the dispatcher gets
 *     around to it.
 *   - Inserting would conflict on (route_destination_id, feed_item_id)
 *     if the item had been dispatched before — and silently swallowing
 *     that with ON CONFLICT would hide failures.
 *
 * Rate-limited (10/min/user) because each call hits an external service
 * and may cost real money on transactional providers (Resend).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<Params> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { id, destId } = await ctx.params
  const ip = clientIp(req)

  const rl = await rateLimit(`test-send:user:${session.uid}`, { limit: 10, windowMs: 60_000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate-limited', code: 'rate-limited', retryAfterSec: rl.retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  // Load everything we need under RLS — destination, route's feed, the
  // newest feed_item for that feed. If the feed has no items yet (never
  // polled successfully) we return a friendly 409 so the UI can suggest
  // "wait for first poll."
  const ctxRow = await withUser(session.uid, async (tx) => {
    const rows = await tx.execute<{
      sink_type: string; sink_id: string; destination: string | null
      enabled: boolean
      feed_id: string; feed_label: string
      item_id: string | null; item_title: string | null
      item_link: string | null; item_summary: string | null
    }>(sql`
      SELECT rd.sink_type, rd.sink_id, rd.destination, rd.enabled,
             f.id AS feed_id, f.label AS feed_label,
             fi.id AS item_id, fi.title AS item_title,
             fi.link AS item_link, fi.summary AS item_summary
      FROM route_destinations rd
      JOIN routes r  ON r.id = rd.route_id
      JOIN feeds  f  ON f.id = r.feed_id
      LEFT JOIN LATERAL (
        SELECT id, title, link, summary
        FROM feed_items
        WHERE feed_id = f.id
        ORDER BY COALESCE(published_at, fetched_at) DESC
        LIMIT 1
      ) fi ON true
      WHERE rd.id = ${destId}::uuid AND rd.route_id = ${id}::uuid
      LIMIT 1
    `)
    return rows[0] ?? null
  })

  if (!ctxRow) return NextResponse.json({ error: 'not-found' }, { status: 404 })
  if (!ctxRow.item_id) {
    return NextResponse.json(
      { error: 'no-items', code: 'no-items', message: 'feed has no items yet — wait for the first successful poll' },
      { status: 409 },
    )
  }

  // Load the actual sink (RLS-bypass since worker_role / owner; same
  // pattern as the dispatcher).
  let sink: SinkSmtp | SinkResend | SinkNtfy | SinkDiscordWebhook | undefined
  await withUser(session.uid, async (tx) => {
    if (ctxRow.sink_type === 'smtp') {
      const r = await tx.execute<SinkSmtp>(sql`SELECT * FROM sinks_smtp WHERE id = ${ctxRow.sink_id}::uuid LIMIT 1`)
      sink = r[0]
    } else if (ctxRow.sink_type === 'resend') {
      const r = await tx.execute<SinkResend>(sql`SELECT * FROM sinks_resend WHERE id = ${ctxRow.sink_id}::uuid LIMIT 1`)
      sink = r[0]
    } else if (ctxRow.sink_type === 'ntfy') {
      const r = await tx.execute<SinkNtfy>(sql`SELECT * FROM sinks_ntfy WHERE id = ${ctxRow.sink_id}::uuid LIMIT 1`)
      sink = r[0]
    } else if (ctxRow.sink_type === 'discord_webhook') {
      const r = await tx.execute<SinkDiscordWebhook>(sql`SELECT * FROM sinks_discord_webhook WHERE id = ${ctxRow.sink_id}::uuid LIMIT 1`)
      sink = r[0]
    }
  })
  if (!sink) return NextResponse.json({ error: 'sink-not-found' }, { status: 404 })

  // Format the same way the dispatcher does so what the user sees in the
  // test is what they'd see in a real dispatch.
  const subject = ctxRow.item_title ?? `(no title) — ${ctxRow.feed_label}`
  const summary = ctxRow.item_summary ?? ''
  const link = ctxRow.item_link ?? ''
  const text = [
    ctxRow.item_title ?? '(no title)',
    '',
    summary,
    '',
    link,
    '',
    `— from ${ctxRow.feed_label} · Euphoric Notify (test)`,
  ].filter(Boolean).join('\n')

  let result
  if (ctxRow.sink_type === 'smtp') {
    if (!ctxRow.destination) {
      return NextResponse.json({ error: 'missing-destination', code: 'missing-destination' }, { status: 400 })
    }
    const smtpSink = sink as SinkSmtp
    result = await sendViaSmtp(smtpSink, {
      to: ctxRow.destination,
      subject,
      text,
      messageId: `<srn-test-${destId}-${ctxRow.item_id}@${smtpSink.from_email.split('@')[1] ?? 'localhost'}>`,
    })
  } else if (ctxRow.sink_type === 'resend') {
    if (!ctxRow.destination) {
      return NextResponse.json({ error: 'missing-destination', code: 'missing-destination' }, { status: 400 })
    }
    result = await sendViaResend(sink as SinkResend, {
      to: ctxRow.destination,
      subject,
      text,
      idempotencyKey: `srn-test-${destId}-${ctxRow.item_id}`,
    })
  } else if (ctxRow.sink_type === 'ntfy') {
    const ntfySink = sink as SinkNtfy
    const message = summary ? summary.slice(0, 1500) : (link || '(no body)')
    result = await publishToNtfy(ntfySink, {
      title: ctxRow.item_title ?? ctxRow.feed_label,
      message,
      click: ntfySink.include_link && link ? link : undefined,
      idempotencyKey: `srn-test-${destId}-${ctxRow.item_id}`,
    })
  } else {
    const discordSink = sink as SinkDiscordWebhook
    const message = summary || link || '(no body)'
    result = await publishToDiscord(discordSink, {
      title: ctxRow.item_title ?? ctxRow.feed_label,
      message,
      link: link || undefined,
      idempotencyKey: `srn-test-${destId}-${ctxRow.item_id}`,
    })
  }

  void writeAudit({
    actor_user_id: session.uid,
    action: result.ok ? 'route.destination.test-with-latest.ok' : 'route.destination.test-with-latest.failed',
    target_type: 'route_destination',
    target_id: destId,
    after: {
      route_id: id,
      feed_item_id: ctxRow.item_id,
      ok: result.ok,
      code: result.code,
      error: result.error,
    },
    via: 'web',
    ip,
  })

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error, code: result.code }, { status: 502 })
  }
  return NextResponse.json({
    ok: true,
    providerMessageId: result.providerMessageId,
    item: { id: ctxRow.item_id, title: ctxRow.item_title },
  })
}
