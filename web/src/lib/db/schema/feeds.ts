import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { users } from './users'

/**
 * RSS feed sources and how they fan out.
 *
 *   feeds       — one row per RSS URL the user is watching
 *   feed_items  — the dedup ledger: one row per (feed, guid) ever seen
 *   routes      — M:N(ish) glue tying a feed to a sink (with the destination
 *                 email address baked in; PR9+ will add ntfy sinks here too)
 *   dispatches  — per-(route, feed_item) record: pending → sent | failed
 *
 * RLS (migration 0005) keys everything off app.current_user_id, the same
 * pattern used for sinks.
 *
 * Backfill control on feed-add: when a user adds a feed, they choose how
 * many existing items to send: none / last N posts / last X days, and
 * whether to pace them out (one every backfill_pace_seconds). After the
 * first poll completes, the backfill columns get cleared — backfill
 * applies once. See worker/rssPoller.ts.
 */

export const feeds = pgTable(
  'feeds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    url: text('url').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Poll interval in seconds. Default 15 min; floor 60 s in API validation. */
    poll_interval_s: integer('poll_interval_s').notNull().default(900),

    /** HTTP cache hints; populated on every fetch so the next fetch can 304. */
    etag: text('etag'),
    last_modified: text('last_modified'),

    last_polled_at: timestamp('last_polled_at', { withTimezone: true }),
    last_success_at: timestamp('last_success_at', { withTimezone: true }),
    last_error: text('last_error'),
    last_error_at: timestamp('last_error_at', { withTimezone: true }),
    /** Consecutive failures; reset on success. Used by future backoff. */
    consecutive_failures: integer('consecutive_failures').notNull().default(0),

    /**
     * Backfill behavior on the FIRST poll only. After the first poll
     * completes, backfill_mode gets set to 'done' so subsequent polls
     * just send new items.
     */
    backfill_mode: text('backfill_mode').notNull().default('none'), // 'none' | 'count' | 'days' | 'done'
    backfill_value: integer('backfill_value').notNull().default(0),
    backfill_pace_seconds: integer('backfill_pace_seconds').notNull().default(0),

    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    user_idx: index('feeds_user_idx').on(t.user_id),
    enabled_idx: index('feeds_enabled_idx').on(t.enabled, t.last_polled_at),
  }),
)

export const feed_items = pgTable(
  'feed_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    feed_id: uuid('feed_id').notNull().references(() => feeds.id, { onDelete: 'cascade' }),
    /** RSS <guid> if present, else feed URL+link hash; fallback dedup key. */
    guid: text('guid').notNull(),
    link: text('link'),
    title: text('title'),
    summary: text('summary'),
    /** From the feed's <pubDate> / <updated> when available. */
    published_at: timestamp('published_at', { withTimezone: true }),
    fetched_at: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One row per (feed, guid) — the actual dedup primitive.
    feed_guid_unique: uniqueIndex('feed_items_feed_guid_unique').on(t.feed_id, t.guid),
    feed_published_idx: index('feed_items_feed_published_idx').on(t.feed_id, t.published_at),
  }),
)

export const routes = pgTable(
  'routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    feed_id: uuid('feed_id').notNull().references(() => feeds.id, { onDelete: 'cascade' }),
    /** Sink type discriminator: 'smtp' | 'resend' | 'ntfy'. */
    sink_type: text('sink_type').notNull(),
    sink_id: uuid('sink_id').notNull(),
    /**
     * Per-route override of where the sink delivers. NULL for ntfy
     * (sink.topic is the destination); required email address for SMTP
     * and Resend. API validation enforces this discrimination.
     */
    destination: text('destination'),
    label: text('label'),
    enabled: boolean('enabled').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    user_idx: index('routes_user_idx').on(t.user_id),
    feed_idx: index('routes_feed_idx').on(t.feed_id, t.enabled),
  }),
)

export const dispatches = pgTable(
  'dispatches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    route_id: uuid('route_id').notNull().references(() => routes.id, { onDelete: 'cascade' }),
    feed_item_id: uuid('feed_item_id').notNull().references(() => feed_items.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** State machine: 'pending' → 'sent' | 'failed' | 'skipped'. */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Scheduled send time. Equals fetched_at for immediate; later for paced backfill. */
    scheduled_at: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    dispatched_at: timestamp('dispatched_at', { withTimezone: true }),
    error: text('error'),
    provider_message_id: text('provider_message_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One row per (route, feed_item) — prevents the dispatcher from re-sending
    // an item to the same destination twice.
    route_item_unique: uniqueIndex('dispatches_route_item_unique').on(t.route_id, t.feed_item_id),
    // Index the poller uses to find work: WHERE status='pending' AND scheduled_at <= now()
    pending_idx: index('dispatches_pending_idx').on(t.status, t.scheduled_at),
  }),
)

export type Feed = typeof feeds.$inferSelect
export type Route = typeof routes.$inferSelect
export type FeedItem = typeof feed_items.$inferSelect
export type Dispatch = typeof dispatches.$inferSelect
