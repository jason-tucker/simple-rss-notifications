-- RLS for feeds / feed_items / routes / dispatches added in migration 0004.

GRANT SELECT, INSERT, UPDATE, DELETE ON feeds, feed_items, routes, dispatches TO web_role, worker_role;
--> statement-breakpoint

ALTER TABLE feeds      ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE routes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- A user can only see/touch their own feeds.
DROP POLICY IF EXISTS feeds_owner ON feeds;
CREATE POLICY feeds_owner ON feeds
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint

-- feed_items doesn't have a direct user_id; scope through the parent feed.
-- Using a subquery in the USING clause is the standard Postgres pattern
-- when the foreign key is the ownership anchor. worker_role bypasses RLS
-- so the poller can still write items across all users.
DROP POLICY IF EXISTS feed_items_owner ON feed_items;
CREATE POLICY feed_items_owner ON feed_items
  USING (
    feed_id IN (SELECT id FROM feeds WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  )
  WITH CHECK (
    feed_id IN (SELECT id FROM feeds WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  );
--> statement-breakpoint

DROP POLICY IF EXISTS routes_owner ON routes;
CREATE POLICY routes_owner ON routes
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS dispatches_owner ON dispatches;
CREATE POLICY dispatches_owner ON dispatches
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
