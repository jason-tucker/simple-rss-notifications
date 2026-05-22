-- RLS for sinks_ntfy added in migration 0006.

GRANT SELECT, INSERT, UPDATE, DELETE ON sinks_ntfy TO web_role, worker_role;
--> statement-breakpoint

ALTER TABLE sinks_ntfy ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS sinks_ntfy_owner ON sinks_ntfy;
CREATE POLICY sinks_ntfy_owner ON sinks_ntfy
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
