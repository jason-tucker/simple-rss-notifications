-- Webhook feeds + richer feed_items. Additive except `feeds.url` becoming
-- nullable (webhook feeds have no URL); existing rows are unaffected.

ALTER TABLE "feeds" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'rss';
--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN IF NOT EXISTS "token_hash" text;
--> statement-breakpoint
ALTER TABLE "feeds" ALTER COLUMN "url" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "feeds" ADD CONSTRAINT "feeds_kind_check" CHECK ("kind" IN ('rss', 'webhook'));
--> statement-breakpoint
ALTER TABLE "feeds" ADD CONSTRAINT "feeds_kind_url_check" CHECK ("kind" <> 'rss' OR "url" IS NOT NULL);
--> statement-breakpoint
-- Ingest looks the feed up by sha256(token); unique + partial keeps RSS rows out.
CREATE UNIQUE INDEX IF NOT EXISTS "feeds_token_hash_unique" ON "feeds" ("token_hash") WHERE "token_hash" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "feed_items" ADD COLUMN IF NOT EXISTS "priority" smallint NOT NULL DEFAULT 3;
--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN IF NOT EXISTS "color" text;
--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'rss';
--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN IF NOT EXISTS "raw" jsonb;
--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_priority_check" CHECK ("priority" BETWEEN 1 AND 5);
--> statement-breakpoint
-- GET /api/items orders newest-first by received time.
CREATE INDEX IF NOT EXISTS "feed_items_fetched_idx" ON "feed_items" ("fetched_at" DESC, "id" DESC);
