# Changelog

All notable changes to this project. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 minor bumps land per merged PR; patch bumps for fix-only PRs.

## [0.14.0] — 2026-05-24 — PR14: per-feed Cookie header for authenticated RSS

### Added
- **Optional `Cookie:` header per feed.** Some RSS sources (XenForo's per-user aggregator `/forums/-/index.rss`, paid news feeds, anything behind a session) only serve items to logged-in requesters. You can now paste the relevant `Cookie:` value in the feed create / edit form and the worker will send it on every poll.
- **Encrypted at rest** with AES-256-GCM — same 4-column layout (`cookie_ciphertext` / `cookie_iv` / `cookie_tag` / `cookie_key_version`) the SMTP password and ntfy token use. NULL ciphertext = "no cookie, fetch unauthenticated", same as before.
- **Migration 0011** (`0011_feeds_cookie.sql`) adds the four nullable columns to `feeds`.
- **Edit form** shows "cookie set" and an explicit "Remove the saved cookie" checkbox when one is stored; omitting the field preserves the existing value (same convention the sink PATCH routes use for password / api_key / token).
- **CR/LF stripped** from the cookie value before it goes on the wire so a pasted multi-line cookie can't inject extra headers.
- **Decrypt failure surfaces as a feed error** — if the encryption key rotates and the stored cookie can't be decoded, the feed gets `last_error = "cookie decryption failed (key mismatch?)"` and shows in the Feed Health banner instead of silently returning an empty body.

### Why
- NewDay's forum RSS (`https://newdayrp.com/forums/-/index.rss`) returns an empty 624-byte channel stub to unauthenticated requests — they've disabled per-subforum RSS and gated the aggregator behind a session. Without cookie support there's no way to read it from the worker. This is a one-feed pain point today but the same pattern hits XenForo, Discourse, Patreon, anything WordPress-with-paywall-plugin, etc.

### Audit / security
- `cookie` is redacted to `[REDACTED]` in audit log entries (added `redactSecretFields(parsed.data, ['cookie'])` to both the feed create and update paths — those routes previously didn't redact because there were no secret fields).
- `GET /api/feeds` returns `has_cookie: boolean` derived from `cookie_ciphertext IS NOT NULL`; the ciphertext itself never leaves the server.

## [0.13.0] — 2026-05-23 — PR13: notification formatting overhaul

### Added — `lib/rss/format.ts`
- **`htmlToPlainText`** — converts RSS-shipped HTML to readable plain text. Handles `<p>` / `<br>` / `<h1>`-`<h6>` / `<li>` / `<blockquote>` as block breaks, `<a href="X">label</a>` becomes `label (X)` so links survive, named entities (`&nbsp;`, `&mdash;`, etc.) + numeric entities decode, `<script>` / `<style>` / `<svg>` dropped entirely, whitespace collapsed.
- **`sanitizeHtmlForEmail`** — allowlist sanitizer for the HTML email body. Drops `<script>` / `<style>` / `<iframe>` / `<object>` / `<embed>` with their content, strips `on*` event handlers, rejects `href` / `src` values that aren't `http(s)` / `mailto:` / relative, keeps a curated set of formatting / heading / list / table / image tags. Adds `rel="noopener noreferrer nofollow" target="_blank"` to surviving anchors.
- **`htmlToDiscordMarkdown`** — `**bold**`, `*italic*`, `` `code` ``, `[label](url)`, `> blockquote`, `- bullets`, ```` ```code blocks``` ````. Headings render as bold paragraphs; bare URLs use Discord's `<url>` auto-embed form.
- **`buildFeedItemBody`** — returns `{ text, html }` for email. HTML body includes a heading, sanitized summary, clickable link, hr separator, small footer.
- **`buildDiscordEmbed`** — returns a Discord rich embed: `title` (clickable via `url`), markdown `description`, `author.name = feed label`, `timestamp = published_at`, footer "Euphoric Notify", brand-violet color `0xa78bfa`. Discord limits respected (title 256, description 3500 to stay under the 6000 combined cap).
- **`buildNtfyBody`** — plain-text from HTML, trimmed to 1500 chars on a word boundary.
- **`truncate`** — graceful word-boundary cut with ellipsis.

### Changed
- **Dispatcher** now calls the right builder per sink type. SMTP + Resend get both `text` + `html` bodies; ntfy gets trimmed plain text; Discord (when `use_embeds=true`) gets the rich embed, (when `use_embeds=false`) markdown content.
- **`/api/routes/[id]/destinations/[destId]/test-with-latest`** uses the same builders so the test button shows the exact final rendering.
- **Discord webhook publisher** now accepts a pre-built `embed` arg that overrides the minimal default shape.
- **`feed_items.summary` storage cap** bumped 4 KB → 200 KB. The old slice was cutting mid-word on long bulletins like UniFi advisories; 200 KB is enough for any practical RSS item while still bounding against a hostile source. Existing rows aren't backfilled — they'll re-populate on the next successful poll per feed.

### Why
- Plain-text emails were arriving with raw HTML tags (`<p>`, `<strong>`, `&nbsp;`, etc.) visible because the RSS source's `<description>` is HTML and we were piping it through unchanged.
- Discord embeds were getting plain-text descriptions (no markdown / links) so they looked flat.
- ntfy push bodies had angle brackets on phone notifications.

## [0.12.2] — 2026-05-23

### Fixed
- Worker crashed every successful poll with `Received an instance of Date` because the bulk `INSERT INTO feed_items` was interpolating `it.publishedAt` (a JS Date from the parser) as a SQL parameter. postgres-js's protocol-level parameter encoder hit `Buffer.byteLength(date)` and threw — looks like the bundled timestamptz serializer doesn't ToString the Date before sending. Workaround: explicitly `.toISOString()` the value and add an `::timestamptz` cast on the SQL side. Sidesteps whichever serializer mis-fired. Stack trace (added in v0.12.1) made the call site obvious.

## [0.12.1] — 2026-05-23

### Fixed (diagnostic)
- Worker's `work-loop-error` log now includes the full stack trace. The bare `.message` was too thin to localize a `Received an instance of Date` error that crashes every poll attempt; the stack identifies the call site.

## [0.12.0] — 2026-05-22 — PR12: Feed Health banner

### Added
- **Feed Health banner** at the top of `/dashboard/activity` listing every feed with `consecutive_failures > 0`. Shows label, URL, failure count, and `last_error`. Each entry links to the feed's edit page so you can fix the URL or disable.
- **Smaller red banner on the dashboard home** ("N feed(s) failing to poll") that links to `/dashboard/activity` where the full list lives.

### Why
- "Why are there no dispatches in Activity?" — the worker's poll failures live on `feeds.consecutive_failures` / `feeds.last_error`, **not** on `dispatches`. The activity table is per-item-per-destination, so a feed that never fetches successfully has zero rows there. Previously that meant fetch-level failures were only visible by clicking into each feed individually.
- Closes that UX gap by surfacing fetch failures at the same place users go to ask "what's happening with my notifications?"

### Notes
- This is presentation-only — no schema changes, no dispatcher changes. The existing `consecutive_failures` increment in the poller is what feeds the banner.
- Banner shows enabled and disabled feeds alike; if you don't want noise, disable the feed.

## [0.11.0] — 2026-05-22 — PR11: "Send latest item" test per destination

### Added
- **"Send latest" button** on every destination row in the route edit page. Sends the most recent `feed_item` (newest by `published_at`, then `fetched_at`) from the route's feed through that destination's sink — same formatting the dispatcher uses, so you can preview a real-shape notification without waiting for the next poll.
- **`POST /api/routes/[id]/destinations/[destId]/test-with-latest`** — picks the newest item via a lateral subquery, loads the destination's sink, calls the right publisher (SMTP / Resend / ntfy / Discord). Rate-limited 10/min/user (shares the `test-send` bucket since it costs real money on transactional providers).
- UI translates the specific error codes inline:
  - `no-items` (409) — "Feed has no items yet — wait for the first poll"
  - `missing-destination` (400) — "Set a destination email first, then Save"
  - `rate-limited` (429) — shows `Retry-After`
- Intentionally does **NOT** record a `dispatches` row. This is a test, not a delivery: the dispatcher still sends the item in its own time on the next poll cycle, and the test path doesn't conflict with the dispatcher's unique key or pollute `/dashboard/activity`.
- Audit-logged as `route.destination.test-with-latest.{ok,failed}`.

## [0.10.0] — 2026-05-22 — PR10: Perf pass

### Changed
- **`/dashboard/sinks`** and **`/dashboard/activity`** fan their 4-way page queries out across parallel `withUser()` transactions. `Promise.all` inside a single drizzle tx doesn't help (postgres-js serializes queries on a single connection); spawning N transactions gives N connections in parallel. Wall-clock drops from sum(queries) → max(queries).
- **Worker idle wakeup is now event-driven.** New `lib/db/notify.ts` emits `pg_notify('feeds_changed', ...)` after every feed/route/destination CRUD, and `pg_notify('dispatches_changed', ...)` after a retry. `worker/notify.ts` holds a dedicated LISTEN connection and exposes a `waitForKick()` Promise that the work loop races against the idle timeout — sub-second pickup of UI changes instead of waiting up to the full sleep interval.
- **Idle sleep bumped 2s → 5s.** With LISTEN/NOTIFY waking us on real changes, the safety-net poll can be longer; saves a few DB round-trips per minute when there's no work.

### Added
- **Index `dispatches(status, created_at DESC)`** (migration 0010) so the activity page's `WHERE status=? ORDER BY created_at DESC LIMIT 100` doesn't full-scan once dispatch history grows.
- **Index `feed_items(feed_id)`** for the activity-by-feed filter join. Both are no-ops on a small DB but pay back fast.

### Caching
- **Caddy adds `Cache-Control: public, max-age=31536000, immutable`** for `/_next/static/*`. Next.js fingerprints those filenames so they're safe to cache forever — browser stops re-downloading hashed JS/CSS bundles between page loads.
- Caddy adds `max-age=86400` for the favicon/icon routes (`/icon`, `/icon.png`, `/apple-icon`, `/apple-icon.png`, `/favicon.ico`).

### Notes
- Worker's LISTEN connection is its own postgres-js client (`max:1`, `idle_timeout:0`) because LISTEN blocks the connection. postgres-js auto-reconnects but does NOT replay LISTEN on reconnect — the subscriber's `onConnect` re-issues the subscription on every (re)connect.
- NOTIFY payloads are empty strings. We never put PII or secrets in them (Postgres caps NOTIFY at 8 KiB anyway).
- Retry failures (NOTIFY emit failure) are non-fatal — the worker's 5s safety-net poll catches the change either way.

## [0.9.0] — 2026-05-22 — PR9: Activity dashboard + retry

### Added
- **`/dashboard/activity`** page — last 100 dispatches across all routes/sinks with status chips (`sent`/`pending`/`failed`/`skipped`), per-row error pre-block, attempt count, scheduled/last-tried timestamps, and a "Source ↗" link to the feed item. Filter pills (All / Pending / Sent / Failed / Skipped) with live counts; a feed-picker form narrows further.
- **Retry button** on failed dispatches. Resets `status='pending'`, `attempts=0`, `scheduled_at=now()`, clears `error` — worker picks it up on its next tick. Permanent-failure codes (sink-incomplete, EAUTH, discord-http-4xx, etc.) will fail again immediately if the underlying problem isn't fixed; the retry button doesn't paper over them.
- **`GET /api/dispatches`** — paginated list with `status` / `feed_id` / `route_id` / `limit` / `offset` filters, joining routes + feed_items + the right sink table to assemble per-row context.
- **`POST /api/dispatches/[id]/retry`** — `failed → pending`, 409 if the dispatch is in any other state, rate-limited 30/min/user, audit-logged.
- **Dashboard home** dispatch summary line is now a link to `/dashboard/activity`; the failed-in-24h count links straight to the filtered view.

### Notes
- Retry counter resets to 0 so the exponential backoff ladder starts fresh on the next attempt.
- Activity rows are returned sorted by `created_at DESC` so backfill bursts read newest-first.

## [0.8.0] — 2026-05-22 — PR8: Routes overhaul + Discord webhook sink

### Changed — route model (breaking, auto-migrated)
- **A route is now `feed + label + N destinations`.** Previously each route was 1:1 (feed × sink × destination). The new shape: `routes(id, user_id, feed_id, label, enabled)` + `route_destinations(id, route_id, sink_type, sink_id, destination, enabled, …)`. Each destination delivers independently; per-destination state and per-destination toggles.
- **Migration 0008** moves existing routes data into the new shape inside the same transaction that drops the old columns — live deployments transition without data loss. New unique key on `dispatches(route_destination_id, feed_item_id)` replaces the old `(route_id, feed_item_id)`.
- **`dispatches` gains `route_destination_id`** (NOT NULL after backfill); `route_id` stays as a denormalized convenience. Foreign keys cascade so deleting a destination also drops its dispatch history.
- **RLS** (migration 0009): `route_destinations` policy joins through `routes` for ownership; `sinks_discord_webhook` has its own user_id policy.

### Added — Discord webhook sink
- **`sinks_discord_webhook`** table — encrypted webhook URL at rest (4-tuple AEAD same as the other sinks), optional `username` / `avatar_url` display overrides, `use_embeds` boolean for embed vs plain-text rendering.
- **`lib/discord/webhook.ts`** — POST to the webhook URL with rich embed (title + description + URL) or plain `content`. SSRF guard on every call, errors never include the URL verbatim. `?wait=true` so the response carries the posted message id for audit.
- **API**: `/api/sinks` discriminated union accepts `type: 'discord_webhook'`; `/api/sinks/discord_webhook/[id]` PATCH/DELETE/test all wired. Webhook URL validated to start with `https://discord.com/api/webhooks/` (or canary/ptb variant).
- **UI**: `+ Discord` button on the sinks list, full Discord form in `SinkForm` (webhook URL, display name override, avatar URL, embed toggle), `SinkRow` summary shows `Discord webhook · as "Foo" · embeds`.
- **Worker dispatcher** learns the Discord branch; 4xx errors are permanent, 5xx + network retry with the standard backoff ladder.
- **Test button** posts a real message to the configured webhook.

### Added — new routes UI
- **`/dashboard/routes`** lists each route as a card with destination chips (`SMTP · IONOS → tucker@…`, `NTFY · phone`, `DISCORD · server alerts`).
- **`/dashboard/routes/new`** form has a destinations fieldset with `+ Add destination` to stack as many as you want. Email destinations require an address; ntfy/discord destinations show "delivers to the sink's configured target" instead.
- **`/dashboard/routes/[id]`** edit page lets you rename the route + toggle / save / remove each destination individually, plus add new ones inline.
- **New API endpoints**: `/api/routes/[id]/destinations` POST + `/api/routes/[id]/destinations/[destId]` PATCH/DELETE.

### Notes
- Worker poller now enqueues one dispatch per `(item × route_destination)` instead of `(item × route)`. Existing dispatch rows were backfilled with their derived `route_destination_id` so no in-flight work is lost.
- Old `NewRouteForm` and `RouteRow` components removed (replaced by `RouteForm`, `EditRouteForm`, `RouteCard`).

## [0.7.1] — 2026-05-22

### Fixed
- Logo image broken on the login page (and any other unauth surface). The auth middleware was redirecting `/logo.png` → `/login` because only `/favicon.ico` and `/_next/*` were whitelisted; the Next image optimizer then fetched `/logo.png` internally, got an HTML redirect, and returned 400. Extended the middleware with a static-asset extension allowlist (`.png .jpe?g .svg .gif .ico .webp .avif .css .js .map .woff2? .ttf .otf .txt .xml .webmanifest`). The favicon worked all along because it's served from `app/icon.png` via Next's own metadata routes under `/_next/*`.

## [0.7.0] — 2026-05-22 — PR7: Euphoric Notify rebrand

### Added
- **Product brand: Euphoric Notify** (sibling to Euphoric FM / Euphoric Media). Source logo `http://i.jasontucker.me/o0hnfxw8.png` resized via sharp to `app/icon.png` (32×32 favicon — Next App Router auto-wires the `<link rel="icon">`), `app/apple-icon.png` (180×180 — Next auto-wires the touch icon), `public/logo.png` (512), `public/logo-192.png` (192).
- **`<Brand />`** component (`web/src/components/Brand.tsx`) renders the gradient mark + a sky→violet→fuchsia gradient wordmark. Used on the home header and the login screen.
- **Layout metadata**: `title.default = 'Euphoric Notify'`, `title.template = '%s · Euphoric Notify'`, `applicationName = 'Euphoric Notify'`. Browser tabs and the OS-level webapp name reflect the brand.
- **Login page** now leads with the logo + gradient wordmark and a sign-in subtitle.
- **Home page header** switched from a plain `simple-rss-notifications` h1 to the `<Brand />` mark.
- **Footer** shows `Euphoric Notify v<x.y.z> · <sha>` (gradient on the word "Euphoric") linked to the matching GitHub release.
- **502 fallback** (`landing/502.html`) rebranded with gradient wordmark + matching meta tags.
- **Outbound notification signoff** changed from `— from <feed> (simple-rss-notifications)` to `— from <feed> · Euphoric Notify` in the dispatcher's text body.
- **README** hero now reads `simple-rss-notifications · *Euphoric Notify*` with a callout explaining the codebase-vs-brand split — repo / package / Docker images keep the technical name; only user-facing surfaces show the product brand.

### Notes
- GitHub repo name, package.json `name`, and GHCR image paths are intentionally NOT renamed — that would invalidate the cloudflared ingress, install.sh URLs, and watchtower auto-pull paths. The "Euphoric Notify" surface is purely the running product.

## [0.6.0] — 2026-05-22 — PR6: ntfy sink (RSS → push notifications)

### Added
- **`sinks_ntfy` table** (migration 0006) with `server_url` (default `https://ntfy.sh`), `topic`, optional encrypted bearer `token`, `default_priority` (1–5), `default_tags`, `include_link`. RLS policy in migration 0007. Encryption layout matches the other sinks (4-tuple `ciphertext / iv / tag / key_version`).
- **`routes.destination` is now nullable.** ntfy routes carry no per-route destination — the dispatcher routes to `sink.server_url + sink.topic` directly. API `refine` enforces destination present for SMTP / Resend, absent for ntfy.
- **`lib/ntfy/publish.ts`** — HTTP POST with ntfy's `Title:` / `Priority:` / `Tags:` / `Click:` / `Authorization:` headers. SSRF guard on every call (DNS-resolves so `server_url` can't aim at private addresses or cloud metadata). Header sanitizer strips CR/LF + non-ASCII to block header injection. Errors NEVER include the bearer token in the response.
- **API**: `/api/sinks` POST + `/api/sinks/[type]/[id]` PATCH / DELETE + `/api/sinks/[type]/[id]/test` all gain an ntfy branch. SSRF re-checks on `server_url` create + update. Audit redacts the `token` field.
- **UI**: `+ ntfy` button on the sinks list, ntfy section in `SinkForm` (server URL, topic, optional token, default priority dropdown, tags, include-link toggle), `SinkRow` shows `{server_url}/{topic} · priority {n}` + token-set badge. `NewRouteForm` hides the destination field when an ntfy sink is selected.
- **Test button** on ntfy sinks sends a real push to the configured topic (no `to:` field — there's nowhere else to route an ntfy publish).
- **Worker dispatcher** learns the ntfy branch. Title = item title (falls back to feed label); message = item summary trimmed to 1500 chars; Click = item link when `include_link=true`. ntfy 4xx errors are treated as permanent failures (bad token / topic name); 5xx + network errors retry with the same backoff ladder as the email sinks.
- Dashboard home page sink count now includes ntfy.

## [0.5.2] — 2026-05-22

### Fixed
- Real fix for the worker's `ERR_MODULE_NOT_FOUND: server-only` crash-loop. v0.5.1 added it as a dep, but Next's standalone tracer still doesn't include it in the runtime image (the package isn't reachable from any code Next itself runs). Switched to esbuild `alias` mapping `server-only` to a tiny local noop stub. The marker remains in source for Next's own bundling, the worker bundle has no reference to the real package at runtime, and there's no runtime dep to ship.

## [0.5.1] — 2026-05-22

### Attempted (did not fix)
- Worker container crash-looped on `ERR_MODULE_NOT_FOUND: server-only`. The `server-only` import in shared lib files is marked external in the worker bundle (the marker is meaningless when bundling for the always-server worker), but Next's standalone trace doesn't include the `server-only` package at runtime because nothing in the Next runtime path actually needs it. Tried adding `server-only` as an explicit dep — did NOT work because the standalone tracer only copies packages reachable from Next's own runtime path. Real fix in 0.5.2.

## [0.5.0] — 2026-05-22 — PR5: Feeds + RSS poller + dispatcher

### Added — the full RSS → email loop lands
- **Schema** (migrations 0004 + 0005): `feeds`, `feed_items` (dedup ledger keyed on `(feed_id, guid)`), `routes` (feed→sink with destination), `dispatches` (per-(route, item) state machine: `pending`/`sent`/`failed`/`skipped`). RLS on all four; `feed_items` policy joins through `feeds` for ownership.
- **`lib/ssrf.ts`** — DNS-resolving SSRF guard. Rejects RFC1918, loopback, link-local, cloud metadata (169.254.169.254), CGNAT, multicast, IPv4-mapped IPv6, `*.local`, `*.localhost`. Re-resolves on every fetch so DNS rebinding doesn't slip through. Pattern lifted from `squishybot/poller.ts`.
- **`lib/rss/fetch.ts`** — conditional `GET` with `If-None-Match` / `If-Modified-Since`, 5 MiB body cap, 20 s timeout, gzip/deflate accept, custom UA. Returns a discriminated `not-modified` / `ok` / `error` union.
- **`lib/rss/parse.ts`** — dep-free RSS 2.0 / Atom 1.0 parser. Handles `<item>` and `<entry>`, both Atom self-closing and RSS text `<link>` forms, CDATA, common HTML entities. GUID falls back to a hash of the link if missing.
- **API**: `GET/POST /api/feeds`, `PATCH/DELETE /api/feeds/[id]`, `GET/POST /api/routes`, `PATCH/DELETE /api/routes/[id]`. All wrapped in `withUser`; create/update routes validate the URL through the SSRF guard up front.
- **UI**: `/dashboard/feeds` (list with status / last poll / consecutive failures), `/dashboard/feeds/new` (label, URL, poll-interval, **backfill: none / last N posts / last X days + optional pacing one-every-N-seconds**), `/dashboard/feeds/[id]` (edit). `/dashboard/routes` (list with toggle/delete), `/dashboard/routes/new` (feed × sink × destination).
- **Worker** now polls and dispatches:
  - **`worker/rssPoller.ts`**: picks the next due feed (`ORDER BY last_polled_at ASC NULLS FIRST`), fetches with conditional GET, parses, bulk-inserts `feed_items` (`ON CONFLICT DO NOTHING` is the dedup primitive), enqueues `dispatches` for every enabled route. First-poll honors `backfill_mode`/`value`/`pace_seconds`; subsequent polls send everything new. Sets `backfill_mode='done'` after first poll so backfill applies once. ETag + Last-Modified stored for next fetch.
  - **`worker/dispatcher.ts`**: atomic claim via `WITH picked / UPDATE … RETURNING` (single-statement lock for future multi-worker), loads sink, calls SMTP or Resend, marks `sent`/`failed`/`skipped`. Permanent failures (sink-incomplete, EAUTH, EENVELOPE, 4xx, decrypt-failed) go straight to `failed`; transient ones retry with exponential backoff (60 s → 5 min → 30 min → 1 h) up to 5 attempts.
  - Heartbeat is now an independent timer so a slow poll/dispatch can't starve liveness reporting.
- **Dashboard** home page surfaces feed / route / sink counts and a pending+failed dispatch summary.

### Notes
- The worker still picks work via a 2-second poll loop. Postgres `LISTEN/NOTIFY` for sub-second config propagation will land in a future PR; this is fine for v0.5.0 with at most a handful of feeds.
- Worker bypasses RLS as table owner — by design, so it can poll all users' feeds and dispatch all users' work without juggling roles.

## [0.4.0] — 2026-05-22 — PR4: Encrypted sinks + test-send

### Added
- **`lib/crypto/aead.ts`** — AES-256-GCM via `node:crypto`. Each encrypted field is stored as a 4-tuple `(ciphertext, iv, tag, key_version)`. `key_version` column is plumbed end-to-end so a future `APP_ENCRYPTION_KEY_V2` can rotate without re-encrypting every row at once.
- **`sinks_smtp` + `sinks_resend` tables** (migration 0002), with **RLS policies** keyed off `app.current_user_id` (migration 0003). `web_role` GRANTed RW; `worker_role` inherits BYPASSRLS from PR2.
- **`/api/sinks` REST**: `GET` (list, secrets never returned — only `has_secret: boolean`), `POST` (create SMTP or Resend), `PATCH /api/sinks/[type]/[id]` (partial update — blank password = keep current), `DELETE /api/sinks/[type]/[id]`, `POST /api/sinks/[type]/[id]/test` (rate-limited 10/min/user). Test-send sends an actual email through the sink and records audit row with `ok/code/error`.
- **`lib/email/send.ts`** — outbound adapter. `sendViaSmtp` (nodemailer; surfaces nodemailer's error codes like EAUTH / ETIMEDOUT verbatim) and `sendViaResend` (REST API via `fetch`, optional `Idempotency-Key` for future dispatcher retries). Both refuse to send when `sink.incomplete=true`.
- **`/dashboard/sinks` UI**: list page with per-row Test / Edit / Delete and an inline test-send dialog; `/dashboard/sinks/new` with type-aware form (SMTP fields vs Resend); `/dashboard/sinks/[type]/[id]` for edit. Password field is **write-only**: blank on edit means "keep current," paste a value to rotate. Reveal is intentionally NOT supported in v0.4.0 — that lands with the reauth gate.
- **`lib/audit.ts`** — `writeAudit({...})` for state-changing routes + `redactSecretFields(body, ['password'])` helper. Stored secrets NEVER appear in audit_log rows.
- **Bootstrap**: in addition to the user seed, worker now seeds an **IONOS SMTP sink** for the bootstrap user (`host=smtp.ionos.com`, `port=587`, `username/from=online@jasontucker.me`, password NULL → `incomplete=true`). Independently markered (`app_meta.ionos_sink_seeded_at`) so it runs on existing DBs that already have the user-seed marker. Bootstrap is now split into per-step seeders so future PRs can add more idempotently.
- **Dashboard home page** now shows a sink count card and a yellow banner when any sink is incomplete.
- **`next.config.mjs`**: `serverExternalPackages: ['nodemailer', '@node-rs/argon2']` so the webpack bundle doesn't try to trace either at build time (nodemailer uses dynamic requires; argon2 is a Rust native binding).

## [0.3.1] — 2026-05-22

### Changed
- Password minimum lowered from 12 to 8 characters (zod schema, client-side pre-check, and helper copy on the change-password page). Same minimum will apply to the upcoming reauth password.

## [0.3.0] — 2026-05-22 — PR3: Auth

### Added
- **argon2id password hashing** via `@node-rs/argon2` (Rust-native, OWASP 2024 params: memoryCost=19 MiB, timeCost=2). Hash and verify helpers in `lib/auth/password.ts`.
- **JWT sessions** via `jose` HS512 in a `__Host-session` cookie (httpOnly, secure, SameSite=Lax, path=/). Server-side `jti` is mirrored to `web_sessions` for revocation; `password_changed_at` vs `iat` is the second revocation channel.
- **`withAuth` API wrapper** — verifies cookie, looks up jti, checks `password_changed_at`, enforces CSRF origin check (non-GET), applies per-user (120/min) and per-IP (600/min) rate limits, and gates `requireElevated` (PR4 turns this on for sensitive ops).
- **`lib/ratelimit.ts`** — Postgres sliding-window rate limiter. Single `INSERT … ON CONFLICT DO UPDATE` atomically resets a stale window or increments the current one. `clientIp(req)` trusts `CF-Connecting-IP` (cloudflared is the only ingress path).
- **`lib/auth/csrf.ts`** — Origin-header check against `PUBLIC_BASE_URL`. Defense-in-depth alongside SameSite=Lax cookies.
- **API routes**: `POST /api/auth/login` (rate-limited 5/min/IP + 10/hour/user, dummy-hash branch to avoid username enumeration via timing), `POST /api/auth/logout` (deletes web_sessions row, clears cookie), `POST /api/auth/change-password` (verifies current password, hashes new, deletes ALL sessions for the user, audit-logs with redacted secrets), `GET /api/auth/me`.
- **Pages**: `/login` (form with rate-limit error surfacing), `/account/password` (forced first-login flow + voluntary change). Home page now redirects to `/login` if unauth and to `/account/password` if `must_change_password=true`.
- **`middleware.ts`** — Edge-runtime UX redirect: missing cookie → `/login?next=<path>`. Real session validation still happens in pages/routes (Edge can't reach Postgres).
- **Bootstrap user** seeded on worker boot: `tucker` / `admin` with `must_change_password=true`. Idempotent — writes `app_meta.bootstrap_completed_at` so password changes in `.env` after first boot don't reset the live password. Safety belt also bails if the `users` table is non-empty. Set `BOOTSTRAP_USERNAME=skip` to disable.

### Fixed
- Worker bundle now reports the real `BUILD_VERSION` and `GIT_SHA` in logs and the `worker_heartbeats` row. Replaced inline `esbuild` invocation with `scripts/build-worker.mjs` that injects the values via `--define`. `@node-rs/argon2` is marked external (Rust native — can't be bundled) and resolves from the Next standalone's traced `node_modules` at runtime.

## [0.2.1] — 2026-05-22

### Fixed
- Worker heartbeat upserts failed with `write CONNECTION_ENDED` because `migrate.ts` had a standalone CLI guard (`if (import.meta.url === file://${process.argv[1]})`) that false-positived inside the bundled worker — esbuild rewrites `import.meta.url` to the bundle path, which matches `process.argv[1]`, so the guard called `pg.end()` right after migrations finished and killed the pool before the heartbeat loop could use it. Moved the CLI entry to `web/scripts/migrate.ts` (tsx-only, never bundled).

## [0.2.0] — 2026-05-22 — PR2: DB foundation

### Added
- Drizzle ORM + `postgres-js` + `drizzle-kit` for schema/migrations.
- Initial schema: `users` (with `reauth_password_hash`, `must_change_password`, `password_changed_at`), `web_sessions` (server-side JWT mirror for revocation), `audit_log` (every state-changing route logs here), `rate_limit_buckets` (Postgres-based sliding window, no Redis dep), `worker_heartbeats` (singleton row, web reads for liveness banner), `app_meta` (key/value singleton state, e.g. `bootstrap_completed_at`).
- Postgres roles `web_role` (RLS-enforced, NOLOGIN) and `worker_role` (BYPASSRLS, NOLOGIN). The connecting login user is granted both via `GRANT … TO current_user`; web/worker SET LOCAL ROLE per transaction.
- Row Level Security enabled on `users`, `web_sessions`, `audit_log` with policies keyed off `current_setting('app.current_user_id')`.
- `lib/db/client.ts`: single `postgres-js` pool + drizzle wrapper.
- `lib/db/withUser.ts`: transaction wrapper — `SET LOCAL ROLE web_role` + `set_config('app.current_user_id', userId, true)` so RLS auto-scopes every query inside.
- `lib/db/migrate.ts`: migration runner. Worker invokes on boot. Web NEVER runs migrations (so two web replicas can't race the same DDL).
- Worker bumps from heartbeat-only to: applies migrations on boot, then upserts `worker_heartbeats(id='singleton')` every 30s.
- Dockerfile copies migrations to `/app/migrations` so the bundled worker can apply them at runtime (esbuild can't bundle .sql).

## [0.1.2] — 2026-05-22

### Fixed
- Worker crash-loop: `dist/worker/index.js` threw `ERR_MODULE_NOT_FOUND: zod` because esbuild's `--packages=external` excluded all npm packages, but the Next.js standalone trace only includes Next-runtime deps — not zod. Now esbuild bundles all dependencies into a single worker file, with a `createRequire` banner so the ESM bundle can still load occasional CJS modules at runtime.

## [0.1.1] — 2026-05-22

### Fixed
- Removed per-stack watchtower service. `containrrr/watchtower:latest` requires Docker API ≥ 1.40 which this VPS doesn't speak; it was crash-looping. The host already runs a `nickfedor/watchtower` (maintained fork) in another stack — our containers carry `com.centurylinklabs.watchtower.enable=true` labels so they're picked up automatically without a duplicate per-stack watchtower.
- Removed `WATCHTOWER_POLL_INTERVAL` from `.env.example` since the host's watchtower owns the polling interval.

## [0.1.0] — 2026-05-22

### Added
- Initial repo scaffold: docker-compose (caddy + web + worker + db + watchtower), outer Caddy ingress with 502 fallback landing, env template with required secret refusal, CHANGELOG, README, CLAUDE.md (mandatory rules mirror sibling repos).
- Next.js 15 skeleton (App Router, React 19, Tailwind, TypeScript) wired into docker-compose as the `web` service.
- Separate `worker` service in compose using the same image, gated by `SRN_ROLE=worker`. Heartbeat-only in 0.1.0; real polling lands in PR6/7.
- Footer component on every page displaying `simple-rss-notifications v<package.json version> · <git sha>` per the no-`[Unreleased]` versioning rule.
- `scripts/install.sh` one-shot VPS bootstrap (clones, generates `POSTGRES_PASSWORD`, `SESSION_SECRET`, `APP_ENCRYPTION_KEY`, opens `.env` in nano, pulls GHCR image, `docker compose up -d`).
- GitHub Actions: PR-time build verification (no push); on-merge build + push to `ghcr.io/jason-tucker/simple-rss-notifications{,-web}:latest` + tag push for `v<x.y.z>` releases.
