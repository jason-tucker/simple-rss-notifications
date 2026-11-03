import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { htmlToPlainText } from '@/lib/rss/format'
import type { withUser } from '@/lib/db/withUser'

/** Shape returned by GET /api/items and emitted by /api/items/stream. */
export interface ItemDto {
  id: string
  feedId: string
  feedName: string
  title: string | null
  body: string
  url: string | null
  priority: number
  color: string | null
  source: string
  publishedAt: string | null
  receivedAt: string
}

interface ItemRow {
  id: string
  feed_id: string
  feed_name: string
  title: string | null
  summary: string | null
  link: string | null
  priority: number
  color: string | null
  source: string
  published_at: Date | null
  fetched_at: Date
}

const MAX_BODY_CHARS = 10_000

export function toItemDto(r: ItemRow): ItemDto {
  return {
    id: r.id,
    feedId: r.feed_id,
    feedName: r.feed_name,
    title: r.title,
    body: htmlToPlainText(r.summary).slice(0, MAX_BODY_CHARS),
    url: r.link,
    priority: Number(r.priority),
    color: r.color,
    source: r.source,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
    receivedAt: new Date(r.fetched_at).toISOString(),
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Tx = Parameters<Parameters<typeof withUser>[1]>[0]

export interface ItemQuery {
  feedIds?: string[]
  /** Only items received strictly after this instant. */
  sinceTime?: Date
  /** Only items received strictly after this item (by received time, id). */
  sinceId?: string
  /**
   * With sinceId: if that item no longer exists (deleted, or not visible
   * under RLS), use "received strictly after this instant" instead of
   * returning nothing. Without it a vanished cursor matches no rows.
   */
  sinceIdFallback?: Date
  /** Exact ids (stream path). */
  ids?: string[]
  limit: number
  order?: 'desc' | 'asc'
}

/** Run inside withUser() so RLS scopes rows to the session's user. */
export async function queryItems(tx: Tx, q: ItemQuery): Promise<ItemDto[]> {
  const conds: SQL[] = []
  if (q.feedIds?.length) {
    conds.push(sql`fi.feed_id IN (${sql.join(q.feedIds.map((id) => sql`${id}::uuid`), sql`, `)})`)
  }
  if (q.ids?.length) {
    conds.push(sql`fi.id IN (${sql.join(q.ids.map((id) => sql`${id}::uuid`), sql`, `)})`)
  }
  if (q.sinceTime) conds.push(sql`fi.fetched_at > ${q.sinceTime.toISOString()}::timestamptz`)
  if (q.sinceId && q.sinceIdFallback) {
    // Cursor row if it still exists, else (fallback time, nil uuid): i.e.
    // fetched_at > fallback (plus any rows at exactly that instant).
    conds.push(sql`(fi.fetched_at, fi.id) > (
      SELECT c.fetched_at, c.id FROM (
        SELECT fetched_at, id, 0 AS pri FROM feed_items WHERE id = ${q.sinceId}::uuid
        UNION ALL
        SELECT ${q.sinceIdFallback.toISOString()}::timestamptz, '00000000-0000-0000-0000-000000000000'::uuid, 1
      ) c ORDER BY c.pri LIMIT 1
    )`)
  } else if (q.sinceId) {
    conds.push(sql`(fi.fetched_at, fi.id) > (SELECT fetched_at, id FROM feed_items WHERE id = ${q.sinceId}::uuid)`)
  }
  const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``
  const dir = q.order === 'asc' ? sql`ASC` : sql`DESC`
  const rows = await tx.execute<ItemRow & Record<string, unknown>>(sql`
    SELECT fi.id, fi.feed_id, f.label AS feed_name, fi.title,
           left(fi.summary, 40000) AS summary, fi.link, fi.priority, fi.color,
           fi.source, fi.published_at, fi.fetched_at
    FROM feed_items fi JOIN feeds f ON f.id = fi.feed_id
    ${where}
    ORDER BY fi.fetched_at ${dir}, fi.id ${dir}
    LIMIT ${q.limit}
  `)
  return Array.from(rows).map(toItemDto)
}
