# simple-rss-notifications

> Self-hosted, multi-user notification bridge. RSS feeds in → email, ntfy, or Discord out — all configured from a web UI, no file edits and no restarts to add a feed or rotate a credential.

Branded **Euphoric Notify** in the UI (sibling to Euphoric FM and Euphoric Media). The repo, npm package, and Docker image names stay `simple-rss-notifications` for stability; only user-facing UI shows the Euphoric Notify brand.

## Overview

You add an RSS feed, point it at one or more destinations (an email address, an ntfy topic, a Discord webhook), and the worker polls the feed and fans new items out to every destination. Everything — feeds, routes, destinations, and credentials — is managed through the dashboard; the worker reacts to changes over Postgres `NOTIFY` so nothing needs a restart.

What ships today:

- **RSS → email** via SMTP (nodemailer) or the Resend REST API.
- **RSS → ntfy** (any ntfy server + topic, optional bearer token).
- **RSS → Discord** webhook, with rich embeds (title, clickable link, author = feed label, timestamp) or plain markdown.
- **Backfill control per feed**: `none` / `last N posts` / `last X days`, with optional pacing so adding a busy feed doesn't blast you with a flood of notifications.
- **Per-destination delivery** — each item × destination is its own dispatch row that succeeds or fails independently, with automatic retry and a manual retry button.

Planned (not yet implemented): inbound bridges such as **ntfy → email** and **email → ntfy**.

## Architecture

```
internet
   │
   ▼
Cloudflare Tunnel ──► cloudflared            (standalone container, host network,
   │                  NOT in compose — TUNNEL_TOKEN baked in at create time)
   │  ingress rule → http://localhost:6082
   ▼
caddy  (compose, binds 127.0.0.1:6082 loopback only — no public port)
   │   ├─ on 5xx → landing/502.html
   │   └─ reverse_proxy
   ▼
web    (Next.js 15 — dashboard + API routes, SRN_ROLE=web)
   │
   ▼
db     (Postgres 16, srn-net only, no host port)
   ▲
   │  LISTEN/NOTIFY (feeds_changed, dispatches_changed)
   │
worker (SAME image as web, SRN_ROLE=worker, command=node dist/worker/index.js)
        RSS poller + dispatcher loop
```

**Why web and worker are separate containers** (same image, switched by `SRN_ROLE`):

- Web restarts on every deploy; a separate worker means in-flight RSS dispatches don't get bounced.
- Scaling `web` horizontally later won't double-poll feeds — only the single worker polls.

**Worker wake-up model:** the web side emits `pg_notify('feeds_changed', …)` after any feed/route/destination CRUD and `pg_notify('dispatches_changed', …)` after a retry. The worker `LISTEN`s on both channels (`web/src/worker/notify.ts`) and wakes within sub-second latency. A **5-second** idle poll (`IDLE_SLEEP_MS` in `web/src/worker/index.ts`) is the safety net for feeds whose `poll_interval_s` just elapsed; it is not the primary trigger.

**Why cloudflared is standalone, not in compose:** `compose up -d` recreates containers whenever the compose file or env changes, which would wipe cloudflared's baked-in `TUNNEL_TOKEN` and drop the tunnel. It runs separately as `docker run --network host` from `/home/botuser/cloudflared/` on the host.

## Stack

- **Next.js 15** (App Router) · **React 19** · **TypeScript** · **Tailwind** · shadcn/ui
- **Drizzle ORM** + **postgres-js** · **Postgres 16** (with Row-Level Security)
- **zod** (env + request validation) · **jose** (JWT) · **@node-rs/argon2** (password hashing)
- **nodemailer** (SMTP) + Resend REST · ntfy REST · Discord webhooks
- **Caddy 2** ingress · **cloudflared** Cloudflare Tunnel · packaged with **pnpm**, shipped as Docker images

## Quick start (Local development)

```bash
git clone https://github.com/jason-tucker/simple-rss-notifications
cd simple-rss-notifications/web
pnpm install

# Bring up just Postgres from the compose stack:
docker compose -f ../docker-compose.yml up -d db

# Provide the required secrets (see Configuration) however you like, e.g. a web/.env,
# then run migrations and the dev server:
pnpm db:migrate
pnpm dev            # http://localhost:3000

# In a second terminal, run the worker loop (poller + dispatcher):
SRN_ROLE=worker pnpm worker
```

> Per the project conventions, do **not** run `pnpm typecheck` / `tsc` / `next build` / `pnpm install` on the production VPS — those happen in CI / inside the Docker build only.

For a one-shot VPS install (clones the repo, generates secrets, opens `.env` for editing, then `docker compose up -d`):

```bash
GITHUB_OWNER=jason-tucker bash <(curl -fsSL https://raw.githubusercontent.com/jason-tucker/simple-rss-notifications/main/scripts/install.sh)
```

## Configuration

All configuration is environment-driven and validated by a zod schema in `web/src/lib/env.ts` (lazy-parsed on first read). The app **refuses to start** if a required secret is missing — there is no insecure fallback. See `.env.example` for the full template; `scripts/install.sh` auto-generates the cryptographic secrets on first run.

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | **yes** | 64 hex chars (32 bytes). Signs session JWTs (HS512). |
| `APP_ENCRYPTION_KEY` | **yes** | 64 hex chars (32 bytes). AES-256-GCM key encrypting stored secrets at rest (SMTP passwords, Resend keys, ntfy tokens). |
| `DATABASE_URL` | **yes** | Postgres connection string (validated as a URL). |
| `PUBLIC_BASE_URL` | **yes** | Public origin (validated as a URL). Single source of truth for cookie domain and CSRF origin check — never hardcoded elsewhere. |
| `SRN_ROLE` | no (default `web`) | `web` runs the Next.js server; `worker` runs the poller/dispatcher loop. |
| `BOOTSTRAP_USERNAME` | no (default `tucker`) | First-boot seed user; created only when the `users` table is empty. Set to `skip` to disable. |
| `BOOTSTRAP_PASSWORD` | **yes** (no default) | Password for the seed admin user; forced password-change on first login. Must NOT be empty or `admin` — the worker refuses to seed an admin with a weak/known password. `scripts/install.sh` generates a strong one. |
| `NODE_ENV` | no (default `production`) | `development` / `production` / `test`. |

Deploy-plumbing vars (`WEB_IMAGE`, `CADDY_IMAGE`, `PORT`, `NEXT_HOST`/`NEXT_ALIAS`, `POSTGRES_*`) live in `.env` for the compose stack — see `.env.example`. There are intentionally **no** `WATCHTOWER_*` vars (see Deployment).

## Usage

### Authentication, admin & re-auth

- **Username + password** (argon2id) — no OAuth or third-party identity providers. Login is rate-limited before the password check so brute-forcers can't even burn hashing CPU, and unknown usernames still pay the hashing cost to avoid timing/enumeration leaks.
- **JWT session**: `jose` HS512 token in a `__Host-session` cookie (HttpOnly, Secure, SameSite=Lax), with a server-side `jti` row in `web_sessions` for revocation and a sliding ~3-day TTL. A password change since a token was issued invalidates that token.
- **Admin accounts** (`users.is_admin`, migration `0011_users_is_admin`): the bootstrap user is created as admin; on existing single-user installs the migration back-fills the oldest user. `/dashboard/admin/users` (gated by `requireAdmin()` in `web/src/lib/auth/admin.ts`) lets an admin create accounts, grant/revoke admin, force a password reset, or remove a user — with a last-admin guard so the only remaining admin can't demote or delete themselves into a lockout.
- **Re-auth (step-up) password**: `withAuth()` supports a `requireElevated` option keyed off a separate `users.reauth_password_hash` and an `elevatedUntil` JWT claim (~10 min after a successful re-auth). **This gate is not yet wired on any route** — it's a deferred security-review item (see `security-review/`), not live enforcement today.

### Feeds → routes → destinations → sinks

1. **Feed** — an RSS source (label + URL + poll interval + backfill mode). Feeds can also be **webhook** feeds (see below).
2. **Route** — connects a feed to one or more **destinations**.
3. **Destination** (`route_destinations`) — `(sink_type, sink_id)` plus a per-row `destination` address. Email sinks (SMTP/Resend) require the `destination`; ntfy and `discord_webhook` carry their address on the sink itself. Each destination is independently `enabled`, so you can mute one without deleting it.
4. **Sink** — the configured channel/credential: `sinks_smtp`, `sinks_resend`, `sinks_ntfy`, `sinks_discord_webhook`. Secrets on sinks are encrypted at rest.

Notification bodies are built per sink type: SMTP/Resend get both plain-text and sanitized HTML, ntfy gets trimmed plain text, Discord gets a rich embed (or markdown when embeds are off). A **"Send latest"** button on each destination previews the exact final rendering using the same builders the dispatcher uses.

### Webhook feeds (push ingest)

Instead of polling a URL, create a feed of type **Webhook (push)** in the UI. The app generates a 256-bit random token and shows the full URL **once**:

```
https://<your-host>/api/hooks/<token>
```

Only the SHA-256 of the token is stored (looked up by hash), so a lost URL cannot be recovered — use **Regenerate token** on the feed row to issue a new one (the old URL stops working immediately). Webhook feeds have no URL, are skipped by the RSS poller, and flow through the same routes, destinations and dispatch pipeline as RSS items.

`POST` or `PUT /api/hooks/<token>` is public (no session cookie; the token is the credential). Only a token-shaped path segment (32–128 URL-safe base64 characters) is public: anything else under `/api/hooks/` is treated like any other app path by the middleware (redirect to `/login` without a session cookie). Limits: 64 KB body (413 beyond that); 60 requests/min per feed and 120 requests/min per user across all of that user's hooks (429 + `Retry-After`); 30 unknown/disabled-token requests (404) per minute per IP, after which that IP gets 429 before any token lookup (a slot is reserved before each lookup and handed back when the token is valid, so concurrent requests cannot overshoot it); and a process-wide budget of 600 unknown-token lookups per minute across all IPs (429 for every lookup once spent, until the minute rolls over). These limits are **in-memory, per web process** and reset on restart (a deliberate exception to the Postgres-backed limiter, so unauthenticated traffic cannot write to the database). A body that is not valid JSON is ingested as plain text; an empty payload returns 400. The token is never logged. Responses follow Discord: `204 No Content`, or `200` with `{"id": ..., "title": ..., "content": ...}` when `?wait=true`.

```bash
# Discord-style payload (embeds, fields, footer, color int)
curl -X POST "https://<host>/api/hooks/<token>" \
  -H 'Content-Type: application/json' \
  -d '{"username":"CI","content":"Deploy finished","embeds":[{"title":"Build #42","description":"All green","url":"https://ci.example.com/42","color":3066993,"fields":[{"name":"Branch","value":"main"}],"footer":{"text":"ci.example.com"}}]}'

# ntfy-style: plain-text body + headers (Title/X-Title, Priority/X-Priority/p, Tags, Click) or ?title=&priority=
curl -X POST "https://<host>/api/hooks/<token>" \
  -H 'Title: Backup' -H 'Priority: high' -H 'Tags: floppy_disk' -H 'Click: https://example.com/run/7' \
  -d 'Nightly backup complete'
curl -X POST "https://<host>/api/hooks/<token>?title=Disk&priority=urgent" -d 'Disk 95% full'

# Generic JSON: title/subject, message/body/text/description, url/link/click, priority, tags, color
curl -X PUT "https://<host>/api/hooks/<token>" -H 'Content-Type: application/json' \
  -d '{"title":"Disk full","message":"95% used","priority":"urgent","tags":["disk"],"color":"#ff8800"}'
```

Normalization: Discord payloads use the first embed title (else `username`, else the feed name) as the title, and join `content`, embed descriptions, `name: value` field lines and the footer as the body; the first embed color becomes `#rrggbb`. Plain text becomes the body; unrecognised JSON is pretty-printed. **Priority** is 1–5 (default 3) and accepts numbers or `min/low/default/high/urgent/max`; Discord payloads containing `@everyone`/`@here` default to 4 unless a priority is given explicitly. Items are stored in `feed_items` (`priority`, `color`, `source` = `rss|discord|json|text|ntfy`, truncated `raw` jsonb; migration `0013_webhook_feeds`).

### Read API (desktop / API clients)

Authenticate with the normal session: `POST /api/auth/login`, then send the `__Host-session` cookie (and a same-origin `Origin` header on non-GET requests).

- `GET /api/items?feeds=<id,id>&since=<ISO timestamp | item id>&limit=<=500>` — newest first (default limit 100). `since` is exclusive. Returns `[{id, feedId, feedName, title, body, url, priority, color, source, publishedAt, receivedAt}]` for RSS and webhook items alike (RSS items have priority 3; `body` is plain text, max 10,000 chars).
- `GET /api/items/stream[?feeds=<id,id>]` — Server-Sent Events. Emits `event: item` (`id:` = item id, `data:` = the same JSON shape as above) when a new item arrives, and a `: hb` comment every 15 s. Reconnect with `Last-Event-ID: <item id>` to replay what you missed (up to 500). Max 5 concurrent streams per user. The server re-checks the session every 60 s (logout, revocation, expiry or a password change ends the stream), closes every stream after 30 minutes, aborts a stream whose client stops reading (more than 1 MB queued; queued events are dropped), and closes a stream if an item re-read fails. The server's single `LISTEN items_inserted` connection pings itself every 30 s; if a ping has not come back within 75 s (for example after a dropped database connection that postgres-js failed to re-`LISTEN`), it is replaced, and every open stream replays from its last sent id once the new `LISTEN` succeeds, or is closed if it fails. `EventSource` reconnects automatically with `Last-Event-ID`, so clients should simply reconnect on close. If the `Last-Event-ID` item no longer exists, replay starts from the reconnect time. The Caddyfile skips compression and sets `flush_interval -1` for this path.

### Dispatch, retry & audit

- Every (feed item × destination) becomes one `dispatches` row. State machine: `pending → sent | failed | skipped`.
- Transient failures (network, 5xx) bump an attempts counter and reschedule with **exponential backoff**; unrecoverable errors (auth-failed, incomplete sink) go straight to `failed`. The last error message is stored on `dispatches.error` and surfaced in the UI with a manual **Retry** button — failures never disappear silently.
- **SSRF guard** (`web/src/lib/ssrf.ts`): every user-controlled outbound URL is checked against loopback, link-local, RFC1918 private ranges, IPv4-mapped IPv6, and the `169.254.169.254` cloud-metadata endpoint — including a re-check after DNS resolution to defeat split-horizon DNS.
- **Postgres Row-Level Security** on every user-data table: each web query runs in a transaction whose first statement is `SET LOCAL app.current_user_id`. The worker connects as a separate Postgres role (the table owner) that bypasses RLS at the GRANT level, not in application code.
- **Audit log**: every state-changing route calls `writeAudit({ actor, action, target_type, target_id, before, after, via })`. Stored secrets are always substituted with `[REDACTED]` in `before`/`after`.
- **Rate limiting** is a Postgres sliding-window applied per handler — not a wrapper middleware. The primitives are `rateLimit(key, opts)` and `rateLimitAll(checks)` in `web/src/lib/ratelimit.ts`. Authenticated routes use `withAuth(handler, { rateLimitPerUser, rateLimitPerIp })`, which calls `rateLimit()` internally (defaults 120/min per user, 600/min per IP); sensitive endpoints (login, re-auth, password change, test-send) call `rateLimit()` / `rateLimitAll()` directly with stricter buckets. The one exception is the public webhook ingest endpoint, which uses an in-memory, per-process limiter (`web/src/lib/hooks/rateLimit.ts`) so that unauthenticated requests never write to Postgres.

## Deployment

- **Branch model:** all work targets `main` via PRs. CI (`.github/workflows/ci.yml`) runs `pnpm typecheck` + `pnpm build` and a no-push Docker build on every PR.
- **Release:** merging to `main` triggers `.github/workflows/deploy.yml`, which builds and pushes two images to GHCR:
  - `ghcr.io/jason-tucker/simple-rss-notifications-web` — the Next.js app (used by both the `web` and `worker` services).
  - `ghcr.io/jason-tucker/simple-rss-notifications` — the Caddy ingress image.

  Each is tagged `latest`, `v<x.y.z>` (from `web/package.json`), and `sha-<short>`. The workflow then creates the matching `v<x.y.z>` git tag + GitHub release if it doesn't already exist.
- **Auto-deploy:** there is **no per-stack Watchtower**. The VPS runs a single host-wide `nickfedor/watchtower` (the maintained fork — `containrrr/watchtower:latest` no longer supports this host's Docker API) that polls every container labelled `com.centurylinklabs.watchtower.enable=true` across all stacks and pulls new `:latest` images within ~30s. The `caddy`, `web`, and `worker` services all carry that label.
- **No host ports** beyond the loopback bind `127.0.0.1:${PORT}` for Caddy. Cloudflare Tunnel is the only public ingress; the app assumes zero trust at the cloudflared boundary and does its own authentication.
- **Build identity:** images are built with `--build-arg BUILD_VERSION` + `GIT_SHA`, surfaced via `NEXT_PUBLIC_*` and rendered in the UI footer as `simple-rss-notifications v<version> · <short SHA>` so you always know which build is live.

## Conventions

- **CHANGELOG** ([CHANGELOG.md](./CHANGELOG.md)): every merged PR adds a real, dated SemVer section at the top and bumps `web/package.json` `"version"` in the same commit. Pre-1.0 PRs do a minor bump; fix-only PRs do a patch bump. **No `[Unreleased]` headings.**
- **Main-only branching:** branch from `main`, push, open the PR with `gh pr create --base main`. No long-lived release branches.
- **Project board:** every PR has a card on the [project board](https://github.com/users/jason-tucker/projects/6) (project #6), created before the PR and linked via `gh project item-add`.
- **Commit often:** small, frequent, present-tense commits ("add", "fix", "wire up") — don't batch.
- **Full operating rules** for AI coding tools and contributors live in [CLAUDE.md](./CLAUDE.md) — no host ports, audit every write, dynamic config (no restarts), error handling beyond the happy path, and the deployment specifics above.

---

Issues + PRs: <https://github.com/jason-tucker/simple-rss-notifications> · Project board: <https://github.com/users/jason-tucker/projects/6>
