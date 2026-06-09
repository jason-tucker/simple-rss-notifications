import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { withAuth } from '@/lib/auth/withAuth'
import { withUser } from '@/lib/db/withUser'

export const dynamic = 'force-dynamic'

const Query = z.object({
  status: z.enum(['pending', 'sent', 'failed', 'skipped']).optional(),
  feed_id: z.string().uuid().optional(),
  route_id: z.string().uuid().optional(),
  /** Pagination via simple offset; cursor would be nicer but offset suits a 1-user dashboard. */
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

/**
 * GET /api/dispatches
 *
 * Returns the most recent dispatches (newest first by created_at) joined
 * to the feed item + route + sink so the UI can render a per-row summary
 * with retry buttons.
 *
 * RLS is enforced via withUser — only the caller's own rows are visible.
 */
export const GET = withAuth(async (req, { session }) => {
  const url = new URL(req.url)
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
  }
  const { status, feed_id, route_id, limit, offset } = parsed.data

  return withUser(session.uid, async (tx) => {
    const rows = await tx.execute<{
      id: string; status: string; attempts: number
      scheduled_at: Date; dispatched_at: Date | null
      error: string | null; provider_message_id: string | null
      created_at: Date
      route_id: string; route_label: string | null
      feed_id: string; feed_label: string
      item_title: string | null; item_link: string | null
      item_published_at: Date | null
      sink_type: string; sink_id: string; destination: string | null
      sink_label: string | null
    }>(sql`
      SELECT d.id, d.status, d.attempts, d.scheduled_at, d.dispatched_at,
             d.error, d.provider_message_id, d.created_at,
             r.id AS route_id, r.label AS route_label,
             f.id AS feed_id, f.label AS feed_label,
             fi.title AS item_title, fi.link AS item_link, fi.published_at AS item_published_at,
             rd.sink_type, rd.sink_id, rd.destination,
             COALESCE(ssm.label, sre.label, snt.label, sdw.label) AS sink_label
      FROM dispatches d
      JOIN route_destinations rd ON rd.id = d.route_destination_id
      JOIN routes r ON r.id = d.route_id
      JOIN feed_items fi ON fi.id = d.feed_item_id
      JOIN feeds f ON f.id = fi.feed_id
      LEFT JOIN sinks_smtp           ssm ON rd.sink_type='smtp'            AND ssm.id = rd.sink_id
      LEFT JOIN sinks_resend         sre ON rd.sink_type='resend'          AND sre.id = rd.sink_id
      LEFT JOIN sinks_ntfy           snt ON rd.sink_type='ntfy'            AND snt.id = rd.sink_id
      LEFT JOIN sinks_discord_webhook sdw ON rd.sink_type='discord_webhook' AND sdw.id = rd.sink_id
      WHERE (${status ?? null}::text IS NULL OR d.status = ${status ?? null}::text)
        AND (${feed_id ?? null}::uuid IS NULL OR f.id = ${feed_id ?? null}::uuid)
        AND (${route_id ?? null}::uuid IS NULL OR r.id = ${route_id ?? null}::uuid)
      ORDER BY d.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `)
    const total = await tx.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c FROM dispatches d
      JOIN feed_items fi ON fi.id = d.feed_item_id
      WHERE (${status ?? null}::text IS NULL OR d.status = ${status ?? null}::text)
        AND (${feed_id ?? null}::uuid IS NULL OR fi.feed_id = ${feed_id ?? null}::uuid)
        AND (${route_id ?? null}::uuid IS NULL OR d.route_id = ${route_id ?? null}::uuid)
    `)
    return NextResponse.json({ dispatches: rows, total: total[0]?.c ?? 0 })
  })
})
