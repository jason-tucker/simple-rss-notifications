import { pgTable, uuid, text, integer, boolean, timestamp, customType, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { users } from './users'

// Same bytea customType the sinks schema uses — pg-core's `bytea()` helper
// isn't exported in the version we're on.
const bytea = customType<{ data: Buffer; default: false; notNull: false }>({
  dataType() { return 'bytea' },
})

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

    /**
     * Optional Cookie header to send on every fetch. Encrypted at rest
     * (same AES-256-GCM 4-column layout as SMTP passwords). NULL means no
     * cookie — the request goes out unauthenticated. Used for feeds gated
     * behind a session (XenForo's per-user aggregator URL, paid news, etc.).
     */
    cookie_ciphertext: bytea('cookie_ciphertext'),
    cookie_iv: bytea('cookie_iv'),
    cookie_tag: bytea('cookie_tag'),
    cookie_key_version: integer('cookie_key_version').default(1),

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

/**
 * A route is now a NAMED grouping: one feed → N destinations.
 * Destinations live in `route_destinations`. Old fields (sink_type/sink_id/
 * destination) were moved there by migration 0008.
 */
export const routes = pgTable(
  'routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    feed_id: uuid('feed_id').notNull().references(() => feeds.id, { onDelete: 'cascade' }),
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

/**
 * One row per (route × destination). A route can fan out to many sinks
 * of different types — each gets its own dispatch row downstream so it
 * can succeed or fail independently.
 *
 * `destination` is the per-row delivery address. Required for email
 * sinks (SMTP/Resend); NULL for ntfy and discord_webhook where the
 * delivery address is on the sink itself. API validation enforces it.
 *
 * `enabled` is per-destination so you can mute one sink without
 * deleting it.
 */
export const route_destinations = pgTable(
  'route_destinations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    route_id: uuid('route_id').notNull().references(() => routes.id, { onDelete: 'cascade' }),
    sink_type: text('sink_type').notNull(),
    sink_id: uuid('sink_id').notNull(),
    destination: text('destination'),
    enabled: boolean('enabled').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    route_idx: index('route_destinations_route_idx').on(t.route_id, t.enabled),
  }),
)

export const dispatches = pgTable(
  'dispatches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Each dispatch is per (route_destination, feed_item) — one row per
     * downstream send. Route_id is kept as a denormalized convenience
     * (joins to the parent route without going through route_destinations)
     * but route_destination_id is the foreign key that drives RLS scope
     * and uniqueness.
     */
    route_destination_id: uuid('route_destination_id').notNull().references(() => route_destinations.id, { onDelete: 'cascade' }),
    route_id: uuid('route_id').notNull().references(() => routes.id, { onDelete: 'cascade' }),
    feed_item_id: uuid('feed_item_id').notNull().references(() => feed_items.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    scheduled_at: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    dispatched_at: timestamp('dispatched_at', { withTimezone: true }),
    error: text('error'),
    provider_message_id: text('provider_message_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One row per (destination, feed_item) — prevents the dispatcher
    // from re-sending an item to the same destination twice.
    dest_item_unique: uniqueIndex('dispatches_dest_item_unique').on(t.route_destination_id, t.feed_item_id),
    pending_idx: index('dispatches_pending_idx').on(t.status, t.scheduled_at),
  }),
)

export type Feed = typeof feeds.$inferSelect
export type Route = typeof routes.$inferSelect
export type FeedItem = typeof feed_items.$inferSelect
export type Dispatch = typeof dispatches.$inferSelect
