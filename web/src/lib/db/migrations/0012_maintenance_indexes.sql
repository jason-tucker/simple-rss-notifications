-- Additive performance indexes. No drops, no data rewrites — safe to apply
-- on a live database (both tables are small; plain CREATE INDEX holds its
-- lock only briefly, and CONCURRENTLY is not an option because the drizzle
-- migrator wraps migrations in a transaction).

-- Activity page lists failing feeds via
--   SELECT … FROM feeds WHERE consecutive_failures > 0 ORDER BY consecutive_failures DESC
-- which is a sequential scan today. Partial index keeps healthy feeds out
-- of the index entirely, so it stays tiny.
CREATE INDEX IF NOT EXISTS "feeds_failing_idx" ON "feeds" ("consecutive_failures") WHERE "consecutive_failures" > 0;
--> statement-breakpoint

-- The worker's hourly maintenance sweep deletes stale rate-limit buckets by
--   DELETE FROM rate_limit_buckets WHERE window_start < now() - interval '1 day'
CREATE INDEX IF NOT EXISTS "rate_limit_buckets_window_idx" ON "rate_limit_buckets" ("window_start");
