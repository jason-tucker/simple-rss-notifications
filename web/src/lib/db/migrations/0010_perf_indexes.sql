-- Perf-only migration. Indexes only — no data or shape changes.

-- /dashboard/activity orders by created_at DESC and filters by status.
-- The existing dispatches_pending_idx is for the worker's
-- (status='pending' AND scheduled_at <= now()) claim path — different
-- access pattern. A descending-time index speeds the activity page
-- without affecting the worker's hot path.
CREATE INDEX IF NOT EXISTS dispatches_status_created_idx
  ON dispatches (status, created_at DESC);
--> statement-breakpoint

-- The activity page also filters by feed_id, which currently requires a
-- join + scan on feed_items.feed_id. Add an index on the join key so
-- the filter narrows quickly on big tables. (No-op on a small DB but
-- pays back fast when dispatches grows.)
CREATE INDEX IF NOT EXISTS feed_items_feed_id_idx
  ON feed_items (feed_id);
