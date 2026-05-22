import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { sendViaSmtp, sendViaResend } from '@/lib/email/send'
import { publishToNtfy } from '@/lib/ntfy/publish'
import type { SinkSmtp, SinkResend, SinkNtfy } from '@/lib/db/schema'

type Logger = (msg: string, extra?: Record<string, unknown>) => void

const MAX_ATTEMPTS = 5

/**
 * Drain one pending dispatch (scheduled_at <= now()). Returns true if
 * work was done (caller should loop), false if nothing was ready.
 *
 * State machine: 'pending' → 'sent' | 'failed' | 'skipped'
 *   - 'sent'    success path, dispatched_at + provider_message_id set
 *   - 'failed'  permanent: exceeded MAX_ATTEMPTS or unrecoverable code
 *   - 'skipped' the sink/route was deleted between scheduling and send
 *
 * Retry policy: transient failures (network, 5xx) bump attempts and
 * reschedule with exponential backoff (capped at 1h). Configuration
 * errors (sink incomplete, auth-failed) go straight to 'failed'.
 */
export async function dispatchOnePending(log: Logger): Promise<boolean> {
  // Pick + claim one in a single statement so we can't double-dispatch
  // if/when we add a second worker. UPDATE … RETURNING acts as the lock.
  const claimed = await db.execute<{
    dispatch_id: string; route_id: string; feed_item_id: string
    sink_type: string; sink_id: string; destination: string | null
    item_title: string | null; item_link: string | null; item_summary: string | null
    item_published_at: Date | null
    feed_label: string
    attempts: number
  }>(sql`
    WITH picked AS (
      SELECT id FROM dispatches
      WHERE status = 'pending' AND scheduled_at <= now()
      ORDER BY scheduled_at
      LIMIT 1
    ),
    bumped AS (
      UPDATE dispatches SET attempts = attempts + 1, dispatched_at = now()
      WHERE id = (SELECT id FROM picked)
      RETURNING id, route_id, feed_item_id, attempts
    )
    SELECT b.id AS dispatch_id, b.route_id, b.feed_item_id, b.attempts,
           r.sink_type, r.sink_id, r.destination,
           fi.title AS item_title, fi.link AS item_link, fi.summary AS item_summary, fi.published_at AS item_published_at,
           f.label AS feed_label
    FROM bumped b
    JOIN routes r ON r.id = b.route_id
    JOIN feed_items fi ON fi.id = b.feed_item_id
    JOIN feeds f ON f.id = fi.feed_id
  `)
  const job = claimed[0]
  if (!job) return false

  // Load the sink. RLS isn't in our way (we're the table owner here).
  let sink: SinkSmtp | SinkResend | SinkNtfy | undefined
  if (job.sink_type === 'smtp') {
    const rows = await db.execute<SinkSmtp>(sql`SELECT * FROM sinks_smtp WHERE id = ${job.sink_id}::uuid LIMIT 1`)
    sink = rows[0]
  } else if (job.sink_type === 'resend') {
    const rows = await db.execute<SinkResend>(sql`SELECT * FROM sinks_resend WHERE id = ${job.sink_id}::uuid LIMIT 1`)
    sink = rows[0]
  } else if (job.sink_type === 'ntfy') {
    const rows = await db.execute<SinkNtfy>(sql`SELECT * FROM sinks_ntfy WHERE id = ${job.sink_id}::uuid LIMIT 1`)
    sink = rows[0]
  }

  if (!sink) {
    log('dispatch-skipped', { dispatch_id: job.dispatch_id, reason: 'sink-deleted' })
    await db.execute(sql`UPDATE dispatches SET status = 'skipped', error = 'sink deleted' WHERE id = ${job.dispatch_id}::uuid`)
    return true
  }

  const subject = job.item_title ?? `(no title) — ${job.feed_label}`
  const summary = job.item_summary ?? ''
  const link = job.item_link ?? ''
  const text = [
    job.item_title ?? '(no title)',
    '',
    summary,
    '',
    link,
    '',
    `— from ${job.feed_label} (simple-rss-notifications)`,
  ].filter(Boolean).join('\n')

  let result
  if (job.sink_type === 'smtp') {
    if (!job.destination) {
      await db.execute(sql`UPDATE dispatches SET status = 'failed', error = 'route has no destination', dispatched_at = now() WHERE id = ${job.dispatch_id}::uuid`)
      log('dispatch-failed', { dispatch_id: job.dispatch_id, reason: 'missing-destination' })
      return true
    }
    const smtpSink = sink as SinkSmtp
    result = await sendViaSmtp(smtpSink, {
      to: job.destination,
      subject,
      text,
      messageId: `<srn-${job.dispatch_id}@${smtpSink.from_email.split('@')[1] ?? 'localhost'}>`,
    })
  } else if (job.sink_type === 'resend') {
    if (!job.destination) {
      await db.execute(sql`UPDATE dispatches SET status = 'failed', error = 'route has no destination', dispatched_at = now() WHERE id = ${job.dispatch_id}::uuid`)
      log('dispatch-failed', { dispatch_id: job.dispatch_id, reason: 'missing-destination' })
      return true
    }
    result = await sendViaResend(sink as SinkResend, {
      to: job.destination,
      subject,
      text,
      idempotencyKey: `srn-${job.dispatch_id}`,
    })
  } else {
    // ntfy — no `destination`; the sink itself carries server_url + topic.
    const ntfySink = sink as SinkNtfy
    // Trim summary to keep the push body readable on a phone.
    const message = summary ? summary.slice(0, 1500) : (link || '(no body)')
    result = await publishToNtfy(ntfySink, {
      title: job.item_title ?? job.feed_label,
      message,
      click: ntfySink.include_link && link ? link : undefined,
      idempotencyKey: `srn-${job.dispatch_id}`,
    })
  }

  if (result.ok) {
    await db.execute(sql`
      UPDATE dispatches SET
        status = 'sent',
        dispatched_at = now(),
        provider_message_id = ${result.providerMessageId ?? null},
        error = NULL
      WHERE id = ${job.dispatch_id}::uuid
    `)
    log('dispatch-sent', {
      dispatch_id: job.dispatch_id, sink_type: job.sink_type, destination: job.destination,
      provider_message_id: result.providerMessageId,
    })
    return true
  }

  // Failure — decide retry vs permanent.
  const permanent = isPermanentFailure(result.code)
  const attempts = job.attempts
  if (permanent || attempts >= MAX_ATTEMPTS) {
    await db.execute(sql`
      UPDATE dispatches SET
        status = 'failed',
        dispatched_at = now(),
        error = ${(result.error ?? 'unknown').slice(0, 500)}
      WHERE id = ${job.dispatch_id}::uuid
    `)
    log('dispatch-failed', {
      dispatch_id: job.dispatch_id, code: result.code, error: result.error,
      attempts, permanent,
    })
    return true
  }

  // Transient — reschedule with exponential backoff (60s, 5m, 30m, 1h, 1h).
  const backoffSec = Math.min(3600, 60 * Math.pow(5, attempts - 1))
  await db.execute(sql`
    UPDATE dispatches SET
      status = 'pending',
      scheduled_at = now() + (${backoffSec}::int * interval '1 second'),
      error = ${(result.error ?? 'unknown').slice(0, 500)},
      dispatched_at = NULL
    WHERE id = ${job.dispatch_id}::uuid
  `)
  log('dispatch-retry', {
    dispatch_id: job.dispatch_id, code: result.code, attempts, retry_in_s: backoffSec,
  })
  return true
}

/**
 * sink-incomplete       user hasn't filled the password — no point retrying
 * decrypt-failed        key mismatch — wait for human; retrying won't help
 * sink-deleted          handled above; never reaches here
 * smtp-error EAUTH      wrong creds, won't fix itself
 * smtp-error EENVELOPE  bad from/to, won't fix itself
 * resend-http-4xx       user-config issue
 * ntfy-http-401/403     bad/missing token — user must fix
 * ntfy-http-4xx (other) topic name rejected, payload too large, etc.
 * ssrf-blocked          user pointed sink at private address — won't fix on retry
 *
 * Everything else (timeouts, 5xx, network) is treated as transient.
 */
function isPermanentFailure(code?: string): boolean {
  if (!code) return false
  if (code === 'sink-incomplete') return true
  if (code === 'decrypt-failed') return true
  if (code === 'ssrf-blocked') return true
  if (code === 'EAUTH' || code === 'EENVELOPE') return true
  if (code.startsWith('resend-http-4')) return true
  if (code.startsWith('ntfy-http-4')) return true
  return false
}
