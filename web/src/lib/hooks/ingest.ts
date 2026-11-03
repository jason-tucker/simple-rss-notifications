import 'server-only'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { hashToken } from './token'
import { textToHtml, type NormalizedHook } from './normalize'

export type WebhookFeed = {
  id: string
  user_id: string
  label: string
  enabled: boolean
}

/** Look a webhook feed up by sha256(token). Runs as owner (no session). */
export async function findWebhookFeed(token: string): Promise<WebhookFeed | null> {
  const rows = await db.execute<WebhookFeed>(sql`
    SELECT id, user_id, label, enabled FROM feeds
    WHERE token_hash = ${hashToken(token)} AND kind = 'webhook'
    LIMIT 1
  `)
  return rows[0] ?? null
}

/**
 * Insert the item and fan out dispatches exactly like the RSS poller does
 * (every enabled route x enabled destination of the feed), in one
 * transaction. NOTIFYs are delivered on commit:
 *   - dispatches_changed wakes the worker's dispatcher immediately
 *   - items_inserted {id, feed_id, user_id} feeds the SSE stream (user_id
 *     only lets subscribers skip other users' events; they still re-read
 *     the row through RLS)
 */
export async function ingestItem(
  feed: WebhookFeed,
  n: NormalizedHook,
): Promise<{ id: string; receivedAt: Date }> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; fetched_at: Date }>(sql`
      INSERT INTO feed_items (feed_id, guid, link, title, summary, published_at, priority, color, source, raw)
      VALUES (
        ${feed.id}::uuid, ${randomUUID()}, ${n.url}, ${n.title},
        ${n.body ? textToHtml(n.body) : null},
        ${n.publishedAt ? n.publishedAt.toISOString() : null}::timestamptz,
        ${n.priority}::smallint, ${n.color}, ${n.source},
        ${n.raw === null || n.raw === undefined ? null : JSON.stringify(n.raw)}::jsonb
      )
      RETURNING id, fetched_at
    `)
    const item = rows[0]!

    const dests = await tx.execute<{ route_id: string; destination_id: string }>(sql`
      SELECT r.id AS route_id, rd.id AS destination_id
      FROM routes r
      JOIN route_destinations rd ON rd.route_id = r.id
      WHERE r.feed_id = ${feed.id}::uuid AND r.enabled AND rd.enabled
    `)
    if (dests.length > 0) {
      const values = dests.map((d) => sql`(
        ${d.destination_id}::uuid, ${d.route_id}::uuid, ${item.id}::uuid, ${feed.user_id}::uuid,
        'pending', 0, now()
      )`)
      await tx.execute(sql`
        INSERT INTO dispatches (route_destination_id, route_id, feed_item_id, user_id, status, attempts, scheduled_at)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (route_destination_id, feed_item_id) DO NOTHING
      `)
      await tx.execute(sql`SELECT pg_notify('dispatches_changed', '')`)
    }

    await tx.execute(sql`
      SELECT pg_notify('items_inserted', ${JSON.stringify({ id: item.id, feed_id: feed.id, user_id: feed.user_id })})
    `)
    return { id: item.id, receivedAt: new Date(item.fetched_at) }
  })
}
