import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { sendViaSmtp, sendViaResend } from '@/lib/email/send'
import { publishToNtfy } from '@/lib/ntfy/publish'
import { publishToDiscord } from '@/lib/discord/webhook'
import { buildFeedItemBody, buildDiscordEmbed, buildNtfyBody } from '@/lib/rss/format'
import { isPermanentFailure, retryDelaySec, backoffSec } from '@/lib/retry'
import type { SinkSmtp, SinkResend, SinkNtfy, SinkDiscordWebhook } from '@/lib/db/schema'

type Logger = (msg: string, extra?: Record<string, unknown>) => void

const MAX_ATTEMPTS = 5

// How many due dispatches one loop tick claims and sends concurrently.
// Each send is bounded by its provider timeout (15–20 s), so a batch of
// slow sinks costs one timeout, not five in a row.
const DISPATCH_BATCH_SIZE = 5

type ClaimedJob = {
  dispatch_id: string
  route_destination_id: string
  feed_item_id: string
  sink_type: string; sink_id: string; destination: string | null
  item_title: string | null; item_link: string | null; item_summary: string | null
  item_published_at: Date | null
  feed_label: string
  attempts: number
}

type AnySink = SinkSmtp | SinkResend | SinkNtfy | SinkDiscordWebhook

/**
 * Drain up to DISPATCH_BATCH_SIZE pending dispatches (scheduled_at <=
 * now()) and send them concurrently. Returns true if work was done
 * (caller should loop), false if nothing was ready.
 *
 * State machine per dispatch: 'pending' → 'sent' | 'failed' | 'skipped'
 *   - 'sent'    success path, dispatched_at + provider_message_id set
 *   - 'failed'  permanent: exceeded MAX_ATTEMPTS or unrecoverable code
 *   - 'skipped' the sink/route was deleted between scheduling and send
 *
 * Retry policy: transient failures (network, 5xx, 429) bump attempts and
 * reschedule with exponential backoff (capped at 1h), stretched by the
 * provider's Retry-After hint when one was sent. Configuration errors
 * (sink incomplete, auth-failed, non-429 4xx) go straight to 'failed'.
 * See lib/retry.ts for the policy helpers.
 *
 * Errors are isolated per dispatch: one sink timing out or throwing never
 * blocks the rest of the batch.
 */
export async function dispatchPending(log: Logger): Promise<boolean> {
  // Pick + claim in a single statement so we can't double-dispatch if/when
  // we add a second worker. UPDATE … RETURNING acts as the lock.
  const claimed = await db.execute<ClaimedJob>(sql`
    WITH picked AS (
      SELECT id FROM dispatches
      WHERE status = 'pending' AND scheduled_at <= now()
      ORDER BY scheduled_at
      LIMIT ${DISPATCH_BATCH_SIZE}
    ),
    bumped AS (
      UPDATE dispatches SET attempts = attempts + 1, dispatched_at = now()
      WHERE id IN (SELECT id FROM picked)
      RETURNING id, route_destination_id, feed_item_id, attempts, scheduled_at, created_at
    )
    SELECT b.id AS dispatch_id, b.route_destination_id, b.feed_item_id, b.attempts,
           rd.sink_type, rd.sink_id, rd.destination,
           fi.title AS item_title, fi.link AS item_link, fi.summary AS item_summary, fi.published_at AS item_published_at,
           f.label AS feed_label
    FROM bumped b
    JOIN route_destinations rd ON rd.id = b.route_destination_id
    JOIN feed_items fi ON fi.id = b.feed_item_id
    JOIN feeds f ON f.id = fi.feed_id
    ORDER BY b.scheduled_at, b.created_at
  `)
  if (claimed.length === 0) return false

  const sinks = await loadSinksForBatch(claimed)
  // Concurrency shape: jobs for the SAME route destination send
  // sequentially in claim order (oldest first), so a channel/mailbox/topic
  // still receives its messages chronologically like the old serial
  // dispatcher; DIFFERENT destinations send in parallel for throughput.
  // deliverOne never rejects (it catches internally), so Promise.all is
  // safe and every dispatch in the batch reaches a terminal update.
  const byDestination = new Map<string, ClaimedJob[]>()
  for (const job of claimed) {
    const group = byDestination.get(job.route_destination_id) ?? []
    group.push(job)
    byDestination.set(job.route_destination_id, group)
  }
  await Promise.all(
    [...byDestination.values()].map(async (group) => {
      for (const job of group) {
        await deliverOne(job, sinks.get(`${job.sink_type}:${job.sink_id}`), log)
      }
    }),
  )
  return true
}

/**
 * Load every sink referenced by the batch with one query per sink TYPE
 * (≤4 total) instead of one query per dispatch. RLS isn't in our way —
 * the worker connects as the table owner.
 */
async function loadSinksForBatch(jobs: ClaimedJob[]): Promise<Map<string, AnySink>> {
  const byType = new Map<string, Set<string>>()
  for (const j of jobs) {
    const set = byType.get(j.sink_type) ?? new Set<string>()
    set.add(j.sink_id)
    byType.set(j.sink_type, set)
  }

  const TABLES: Record<string, string> = {
    smtp: 'sinks_smtp',
    resend: 'sinks_resend',
    ntfy: 'sinks_ntfy',
    discord_webhook: 'sinks_discord_webhook',
  }

  const out = new Map<string, AnySink>()
  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      const table = TABLES[type]
      if (!table) return
      const idList = sql.join([...ids].map((id) => sql`${id}::uuid`), sql`, `)
      const rows = await db.execute<AnySink & { id: string }>(sql`
        SELECT * FROM ${sql.raw(table)} WHERE id IN (${idList})
      `)
      for (const row of rows) out.set(`${type}:${row.id}`, row)
    }),
  )
  return out
}

/** Send one claimed dispatch and record its terminal state. Never throws. */
async function deliverOne(job: ClaimedJob, sink: AnySink | undefined, log: Logger): Promise<void> {
  try {
    if (!sink) {
      log('dispatch-skipped', { dispatch_id: job.dispatch_id, reason: 'sink-deleted' })
      await db.execute(sql`UPDATE dispatches SET status = 'skipped', error = 'sink deleted' WHERE id = ${job.dispatch_id}::uuid`)
      return
    }

    const subject = job.item_title ?? `(no title) — ${job.feed_label}`
    const link = job.item_link ?? ''
    const publishedAt = job.item_published_at ? new Date(job.item_published_at) : null

    let result
    if (job.sink_type === 'smtp' || job.sink_type === 'resend') {
      if (!job.destination) {
        await db.execute(sql`UPDATE dispatches SET status = 'failed', error = 'route has no destination', dispatched_at = now() WHERE id = ${job.dispatch_id}::uuid`)
        log('dispatch-failed', { dispatch_id: job.dispatch_id, reason: 'missing-destination' })
        return
      }
      // Email gets both: a real HTML body (sanitized) so clients render
      // formatting, and a plain-text fallback derived from the same source.
      const { text, html } = buildFeedItemBody({
        title: job.item_title,
        summaryHtml: job.item_summary,
        link,
        feedLabel: job.feed_label,
      })
      if (job.sink_type === 'smtp') {
        const smtpSink = sink as SinkSmtp
        result = await sendViaSmtp(smtpSink, {
          to: job.destination,
          subject,
          text,
          html,
          messageId: `<srn-${job.dispatch_id}@${smtpSink.from_email.split('@')[1] ?? 'localhost'}>`,
        })
      } else {
        result = await sendViaResend(sink as SinkResend, {
          to: job.destination,
          subject,
          text,
          html,
          idempotencyKey: `srn-${job.dispatch_id}`,
        })
      }
    } else if (job.sink_type === 'ntfy') {
      // ntfy — sink owns server_url + topic. Body is plain-text rendered
      // from HTML and trimmed for phone-screen readability.
      const ntfySink = sink as SinkNtfy
      const message = buildNtfyBody({
        title: job.item_title,
        summaryHtml: job.item_summary,
        link,
        feedLabel: job.feed_label,
      })
      result = await publishToNtfy(ntfySink, {
        title: job.item_title ?? job.feed_label,
        message,
        click: ntfySink.include_link && link ? link : undefined,
        idempotencyKey: `srn-${job.dispatch_id}`,
      })
    } else {
      // discord_webhook — rich embed (author + title + clickable URL +
      // markdown description + timestamp + footer + brand color).
      const discordSink = sink as SinkDiscordWebhook
      if (discordSink.use_embeds) {
        const embed = buildDiscordEmbed({
          title: job.item_title,
          summaryHtml: job.item_summary,
          link,
          feedLabel: job.feed_label,
          publishedAt,
        })
        result = await publishToDiscord(discordSink, {
          message: '', // unused when embed is set + use_embeds=true
          embed,
          idempotencyKey: `srn-${job.dispatch_id}`,
        })
      } else {
        // Plain-content fallback when user disabled embeds — still render
        // HTML to markdown so Discord shows bold/italic/links properly.
        const md = buildNtfyBody({
          title: job.item_title,
          summaryHtml: job.item_summary,
          link,
          feedLabel: job.feed_label,
        })
        result = await publishToDiscord(discordSink, {
          title: job.item_title ?? job.feed_label,
          message: md,
          link: link || undefined,
          idempotencyKey: `srn-${job.dispatch_id}`,
        })
      }
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
      return
    }

    // Failure — decide retry vs permanent.
    const permanent = isPermanentFailure(result.code)
    if (permanent || job.attempts >= MAX_ATTEMPTS) {
      await db.execute(sql`
        UPDATE dispatches SET
          status = 'failed',
          dispatched_at = now(),
          error = ${(result.error ?? 'unknown').slice(0, 500)}
        WHERE id = ${job.dispatch_id}::uuid
      `)
      log('dispatch-failed', {
        dispatch_id: job.dispatch_id, code: result.code, error: result.error,
        attempts: job.attempts, permanent,
      })
      return
    }

    // Transient — reschedule with exponential backoff (60s, 5m, 25m, 1h),
    // stretched by the provider's Retry-After when it sent one.
    const delaySec = retryDelaySec(job.attempts, result.retryAfterSec)
    await db.execute(sql`
      UPDATE dispatches SET
        status = 'pending',
        scheduled_at = now() + (${delaySec}::int * interval '1 second'),
        error = ${(result.error ?? 'unknown').slice(0, 500)},
        dispatched_at = NULL
      WHERE id = ${job.dispatch_id}::uuid
    `)
    log('dispatch-retry', {
      dispatch_id: job.dispatch_id, code: result.code, attempts: job.attempts,
      retry_in_s: delaySec, retry_after_s: result.retryAfterSec,
    })
  } catch (err) {
    // Unexpected throw (DB hiccup, provider lib bug). Without a terminal
    // update the row would stay claimed-looking but 'pending' with
    // scheduled_at in the past — an immediate-repick hot loop. Reschedule
    // with backoff (or fail permanently past the attempt ceiling).
    log('dispatch-unhandled-error', {
      dispatch_id: job.dispatch_id,
      err: err instanceof Error ? err.message : String(err),
    })
    try {
      if (job.attempts >= MAX_ATTEMPTS) {
        await db.execute(sql`
          UPDATE dispatches SET status = 'failed', dispatched_at = now(),
            error = ${`internal error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500)}
          WHERE id = ${job.dispatch_id}::uuid AND status = 'pending'
        `)
      } else {
        await db.execute(sql`
          UPDATE dispatches SET status = 'pending',
            scheduled_at = now() + (${backoffSec(job.attempts)}::int * interval '1 second'),
            error = ${`internal error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500)},
            dispatched_at = NULL
          WHERE id = ${job.dispatch_id}::uuid AND status = 'pending'
        `)
      }
    } catch {
      // DB fully unavailable — the work loop's own error handling takes over.
    }
  }
}
