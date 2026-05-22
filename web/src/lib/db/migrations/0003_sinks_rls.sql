-- Hand-written: RLS for the sinks tables added in 0002.
-- web_role + worker_role were created in 0001; we just GRANT them access
-- here and enable per-user RLS keyed on app.current_user_id.

GRANT SELECT, INSERT, UPDATE, DELETE ON sinks_smtp, sinks_resend TO web_role, worker_role;
--> statement-breakpoint

ALTER TABLE sinks_smtp   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sinks_resend ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- A user can read/write only sinks they own. NULLIF + ::uuid cast lets a
-- query without the GUC set return zero rows instead of erroring — the
-- web side always sets the GUC inside withUser(), but defending against
-- the unset case is cheap.

DROP POLICY IF EXISTS sinks_smtp_owner ON sinks_smtp;
CREATE POLICY sinks_smtp_owner ON sinks_smtp
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS sinks_resend_owner ON sinks_resend;
CREATE POLICY sinks_resend_owner ON sinks_resend
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
