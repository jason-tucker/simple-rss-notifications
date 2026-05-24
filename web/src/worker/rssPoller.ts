import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { fetchFeed } from '@/lib/rss/fetch'
import { parseFeedBody } from '@/lib/rss/parse'
import { decrypt } from '@/lib/crypto/aead'

type Logger = (msg: string, extra?: Record<string, unknown>) => void

/**
 * Pick the next due feed and poll it. Returns true if work was done so the
 * caller can immediately try the next one (greedy drain); false if nothing
 * was due, so the caller can sleep briefly.
 *
 * Worker runs as the table owner (BYPASSRLS by ownership) — sees every
 * user's feeds. The dispatches we create are written with the feed's
 * user_id so per-user RLS still works for the web view.
 *
 * Concurrency model: only ONE worker container runs in this stack
 * (compose service `worker` is scale=1). If we ever scale, we'd add
 * a `SELECT … FOR UPDATE SKIP LOCKED` to the picker query. Until
 * then a simple `ORDER BY last_polled_at NULLS FIRST LIMIT 1` is fine.
 */
export async function pollOneDueFeed(log: Logger): Promise<boolean> {
  const rows = await db.execute<{
    id: string; user_id: string; url: string; label: string
    poll_interval_s: number; etag: string | null; last_modified: string | null
    backfill_mode: string; backfill_value: number; backfill_pace_seconds: number
    cookie_ciphertext: Buffer | null; cookie_iv: Buffer | null
    cookie_tag: Buffer | null; cookie_key_version: number | null
  }>(sql`
    SELECT id, user_id, url, label, poll_interval_s, etag, last_modified,
           backfill_mode, backfill_value, backfill_pace_seconds,
           cookie_ciphertext, cookie_iv, cookie_tag, cookie_key_version
    FROM feeds
    WHERE enabled
      AND (last_polled_at IS NULL
           OR last_polled_at < now() - (poll_interval_s::int * interval '1 second'))
    ORDER BY last_polled_at ASC NULLS FIRST
    LIMIT 1
  `)
  const feed = rows[0]
  if (!feed) return false

  await pollFeed(feed, log)
  return true
}

interface FeedRow {
  id: string; user_id: string; url: string; label: string
  poll_interval_s: number; etag: string | null; last_modified: string | null
  backfill_mode: string; backfill_value: number; backfill_pace_seconds: number
  cookie_ciphertext: Buffer | null; cookie_iv: Buffer | null
  cookie_tag: Buffer | null; cookie_key_version: number | null
}

async function pollFeed(feed: FeedRow, log: Logger): Promise<void> {
  // Decrypt the stored cookie if present. A decryption failure is treated as
  // a fetch-level error so the feed surfaces in the Feed Health banner with
  // the actual reason — silently dropping the cookie would just look like an
  // empty feed to the user.
  let cookie: string | null = null
  if (feed.cookie_ciphertext && feed.cookie_iv && feed.cookie_tag && feed.cookie_key_version != null) {
    try {
      cookie = decrypt({
        ciphertext: feed.cookie_ciphertext,
        iv: feed.cookie_iv,
        tag: feed.cookie_tag,
        keyVersion: feed.cookie_key_version,
      })
    } catch (err) {
      log('feed-cookie-decrypt-failed', { feed_id: feed.id, label: feed.label, error: err instanceof Error ? err.message : String(err) })
      await db.execute(sql`
        UPDATE feeds SET
          last_polled_at = now(),
          last_error = 'cookie decryption failed (key mismatch?)',
          last_error_at = now(),
          consecutive_failures = consecutive_failures + 1
        WHERE id = ${feed.id}::uuid
      `)
      return
    }
  }

  const result = await fetchFeed(feed.url, { etag: feed.etag, lastModified: feed.last_modified, cookie })

  if (result.kind === 'error') {
    log('feed-fetch-failed', { feed_id: feed.id, label: feed.label, code: result.code, error: result.error })
    await db.execute(sql`
      UPDATE feeds SET
        last_polled_at = now(),
        last_error = ${result.error.slice(0, 500)},
        last_error_at = now(),
        consecutive_failures = consecutive_failures + 1
      WHERE id = ${feed.id}::uuid
    `)
    return
  }

  if (result.kind === 'not-modified') {
    log('feed-not-modified', { feed_id: feed.id, label: feed.label })
    await db.execute(sql`
      UPDATE feeds SET last_polled_at = now(), last_success_at = now(),
        last_error = NULL, last_error_at = NULL, consecutive_failures = 0
      WHERE id = ${feed.id}::uuid
    `)
    return
  }

  // Parse + dedup against feed_items + enqueue dispatches per matching route.
  const items = parseFeedBody(result.body)
  const isFirstPoll = feed.backfill_mode !== 'done'

  // Insert all parsed items into feed_items (ON CONFLICT DO NOTHING — the
  // unique (feed_id, guid) constraint dedups). Return the rows we just
  // inserted so we can fan them out. Items that already existed do NOT
  // get re-dispatched (their unique index conflict suppresses the row).
  let newItems: Array<{ id: string; published_at: Date | null }> = []
  if (items.length > 0) {
    // Bulk insert via VALUES list. Build the args inline; postgres-js
    // safely parameterizes.
    // it.publishedAt is a JS Date from the parser; serialize as ISO + cast
    // so we never hand a raw Date to postgres-js param binding. Storage cap
    // bumped 4 KB → 200 KB so the dispatcher can render real formatted HTML
    // emails; still bounded for safety against a hostile feed.
    const values = items.map((it) => sql`(
      ${feed.id}::uuid,
      ${it.guid},
      ${it.link},
      ${it.title},
      ${it.summary?.slice(0, 200_000) ?? null},
      ${it.publishedAt?.toISOString() ?? null}::timestamptz
    )`)
    // Drizzle's sql.join lets us interpolate the comma-separated list.
    const inserted = await db.execute<{ id: string; published_at: Date | null }>(sql`
      INSERT INTO feed_items (feed_id, guid, link, title, summary, published_at)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (feed_id, guid) DO NOTHING
      RETURNING id, published_at
    `)
    newItems = inserted
  }

  // Pick which new items actually deserve dispatches based on backfill
  // settings (first poll only). After first poll, ALL new items dispatch.
  const itemsToDispatch = isFirstPoll
    ? selectBackfillItems(newItems, feed)
    : newItems

  if (itemsToDispatch.length > 0) {
    // Fan out: join routes → route_destinations, both must be enabled.
    const destRows = await db.execute<{ route_id: string; destination_id: string }>(sql`
      SELECT r.id AS route_id, rd.id AS destination_id
      FROM routes r
      JOIN route_destinations rd ON rd.route_id = r.id
      WHERE r.feed_id = ${feed.id}::uuid AND r.enabled AND rd.enabled
    `)

    if (destRows.length > 0) {
      const pace = isFirstPoll && feed.backfill_pace_seconds > 0 ? feed.backfill_pace_seconds : 0
      // newest-first in the items array; reverse so oldest goes out first
      // (more natural reading order on a backfill blast).
      const ordered = itemsToDispatch.slice().sort((a, b) => {
        const at = a.published_at ? new Date(a.published_at).getTime() : 0
        const bt = b.published_at ? new Date(b.published_at).getTime() : 0
        return at - bt
      })

      const dispatchValues: SQL[] = []
      let idx = 0
      for (const item of ordered) {
        for (const d of destRows) {
          const offsetSec = pace * idx
          dispatchValues.push(sql`(
            ${d.destination_id}::uuid, ${d.route_id}::uuid, ${item.id}::uuid, ${feed.user_id}::uuid,
            'pending', 0, now() + (${offsetSec}::int * interval '1 second')
          )`)
        }
        idx++
      }

      if (dispatchValues.length > 0) {
        await db.execute(sql`
          INSERT INTO dispatches (route_destination_id, route_id, feed_item_id, user_id, status, attempts, scheduled_at)
          VALUES ${sql.join(dispatchValues, sql`, `)}
          ON CONFLICT (route_destination_id, feed_item_id) DO NOTHING
        `)
      }
    }
  }

  // Mark feed polled. If this was the first poll, transition backfill_mode
  // to 'done' so subsequent polls send everything new immediately.
  await db.execute(sql`
    UPDATE feeds SET
      last_polled_at = now(),
      last_success_at = now(),
      last_error = NULL,
      last_error_at = NULL,
      consecutive_failures = 0,
      etag = ${result.etag},
      last_modified = ${result.lastModified},
      backfill_mode = CASE WHEN backfill_mode <> 'done' THEN 'done' ELSE backfill_mode END
    WHERE id = ${feed.id}::uuid
  `)

  log('feed-polled', {
    feed_id: feed.id, label: feed.label,
    parsed: items.length, new_items: newItems.length, dispatched: itemsToDispatch.length,
    first_poll: isFirstPoll,
  })
}

function selectBackfillItems<T extends { id: string; published_at: Date | null }>(
  newItems: T[],
  feed: FeedRow,
): T[] {
  if (feed.backfill_mode === 'none') return []
  if (feed.backfill_mode === 'count') {
    // Items come from RETURNING in arbitrary order; sort newest first to
    // pick the freshest N.
    const sorted = newItems.slice().sort((a, b) => {
      const at = a.published_at ? new Date(a.published_at).getTime() : 0
      const bt = b.published_at ? new Date(b.published_at).getTime() : 0
      return bt - at
    })
    return sorted.slice(0, Math.max(0, feed.backfill_value))
  }
  if (feed.backfill_mode === 'days') {
    const cutoff = Date.now() - feed.backfill_value * 24 * 60 * 60 * 1000
    return newItems.filter((it) => it.published_at && new Date(it.published_at).getTime() >= cutoff)
  }
  return newItems // 'done' (shouldn't hit here on first poll) — pass through
}
