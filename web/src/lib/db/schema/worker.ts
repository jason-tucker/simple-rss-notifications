import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core'

/**
 * Single-row table that the worker upserts to every 30s. The web
 * `/api/health/worker` route reads it and reports "stale" if the
 * last beat is >2 minutes old — the UI then shows a red banner.
 *
 * Single row keyed by id='singleton' (PK so concurrent boots can't
 * insert duplicates).
 */
export const worker_heartbeats = pgTable('worker_heartbeats', {
  id: text('id').primaryKey(),
  last_beat_at: timestamp('last_beat_at', { withTimezone: true }).notNull().defaultNow(),
  build_version: text('build_version'),
  git_sha: text('git_sha'),
  meta: jsonb('meta'),
})

/**
 * Generic key/value store for app-wide singleton state. Used (today) by
 * the bootstrap routine to write `bootstrap_completed_at` so first-boot
 * seeding never re-runs and can never overwrite real user data.
 */
export const app_meta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
