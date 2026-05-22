import { pgTable, text, integer, timestamp } from 'drizzle-orm/pg-core'

/**
 * Sliding-window rate limiter, single table, no Redis. The helper in
 * lib/ratelimit.ts (PR4) does a single INSERT … ON CONFLICT DO UPDATE
 * that resets count when (now - window_start) > windowMs and returns
 * whether the new count exceeded the limit.
 *
 * Bucket key examples:
 *   "login:ip:1.2.3.4"
 *   "login:user:tucker"
 *   "api:user:<uuid>"
 *   "test-send:user:<uuid>"
 */
export const rate_limit_buckets = pgTable('rate_limit_buckets', {
  key: text('key').primaryKey(),
  count: integer('count').notNull().default(0),
  window_start: timestamp('window_start', { withTimezone: true }).notNull().defaultNow(),
})
