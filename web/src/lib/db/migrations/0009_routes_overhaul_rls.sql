-- RLS for tables added in 0008: route_destinations + sinks_discord_webhook.

GRANT SELECT, INSERT, UPDATE, DELETE ON route_destinations, sinks_discord_webhook TO web_role, worker_role;
--> statement-breakpoint

ALTER TABLE route_destinations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sinks_discord_webhook ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- route_destinations has no direct user_id — scope through the parent route.
DROP POLICY IF EXISTS route_destinations_owner ON route_destinations;
CREATE POLICY route_destinations_owner ON route_destinations
  USING (
    route_id IN (SELECT id FROM routes WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  )
  WITH CHECK (
    route_id IN (SELECT id FROM routes WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  );
--> statement-breakpoint

DROP POLICY IF EXISTS sinks_discord_webhook_owner ON sinks_discord_webhook;
CREATE POLICY sinks_discord_webhook_owner ON sinks_discord_webhook
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
