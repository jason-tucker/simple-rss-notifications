-- Routes overhaul — 1:1 routes (feed × sink × destination) → 1:N routes
-- (feed × N route_destinations). Adds Discord webhook sink. Data
-- migration runs INSIDE this migration so existing live deployments
-- keep working.

-- ─── 1. New tables ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "route_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"sink_type" text NOT NULL,
	"sink_id" uuid NOT NULL,
	"destination" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sinks_discord_webhook" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"webhook_url_ciphertext" "bytea",
	"webhook_url_iv" "bytea",
	"webhook_url_tag" "bytea",
	"webhook_url_key_version" integer DEFAULT 1,
	"username" text,
	"avatar_url" text,
	"use_embeds" boolean DEFAULT true NOT NULL,
	"incomplete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ─── 2. FKs + indexes for the new tables ───────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "route_destinations" ADD CONSTRAINT "route_destinations_route_id_routes_id_fk"
    FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sinks_discord_webhook" ADD CONSTRAINT "sinks_discord_webhook_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_destinations_route_idx" ON "route_destinations" USING btree ("route_id","enabled");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sinks_discord_webhook_user_idx" ON "sinks_discord_webhook" USING btree ("user_id");
--> statement-breakpoint

-- ─── 3. Backfill route_destinations from legacy routes columns ─────────────
-- Each pre-PR8 row was a 1:1 route × destination. Split the destination
-- info off into its own row keyed by route_id, BUT only when the old
-- columns still exist (the routes table is mid-flight).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='routes' AND column_name='sink_type'
  ) THEN
    EXECUTE $sql$
      INSERT INTO route_destinations (route_id, sink_type, sink_id, destination, enabled, created_at, updated_at)
      SELECT id, sink_type, sink_id, destination, enabled, created_at, updated_at
      FROM routes
      WHERE NOT EXISTS (SELECT 1 FROM route_destinations rd WHERE rd.route_id = routes.id)
    $sql$;
  END IF;
END $$;
--> statement-breakpoint

-- ─── 4. dispatches gets a route_destination_id column ──────────────────────
ALTER TABLE "dispatches" ADD COLUMN IF NOT EXISTS "route_destination_id" uuid;
--> statement-breakpoint

UPDATE dispatches d
SET route_destination_id = rd.id
FROM route_destinations rd
WHERE rd.route_id = d.route_id AND d.route_destination_id IS NULL;
--> statement-breakpoint

ALTER TABLE "dispatches" ALTER COLUMN "route_destination_id" SET NOT NULL;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_route_destination_id_route_destinations_id_fk"
    FOREIGN KEY ("route_destination_id") REFERENCES "public"."route_destinations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS "dispatches_route_item_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dispatches_dest_item_unique"
  ON "dispatches" USING btree ("route_destination_id","feed_item_id");
--> statement-breakpoint

-- ─── 5. Drop the legacy columns from routes ────────────────────────────────
ALTER TABLE "routes" DROP COLUMN IF EXISTS "sink_type";
--> statement-breakpoint
ALTER TABLE "routes" DROP COLUMN IF EXISTS "sink_id";
--> statement-breakpoint
ALTER TABLE "routes" DROP COLUMN IF EXISTS "destination";
