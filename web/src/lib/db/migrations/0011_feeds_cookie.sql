-- PR14: per-feed Cookie header for authenticated RSS sources.
--
-- Some feeds (XenForo aggregator URLs, paid news sites, etc.) only serve
-- items when the requester carries a session cookie. We store that cookie
-- string encrypted at rest with AES-256-GCM (same 4-column layout as the
-- SMTP password and ntfy token). All four columns are nullable — a NULL
-- ciphertext means "no cookie, send the feed request unauthenticated".

ALTER TABLE "feeds" ADD COLUMN IF NOT EXISTS "cookie_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN IF NOT EXISTS "cookie_iv" "bytea";--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN IF NOT EXISTS "cookie_tag" "bytea";--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN IF NOT EXISTS "cookie_key_version" integer DEFAULT 1;
