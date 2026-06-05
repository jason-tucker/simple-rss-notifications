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
| `BOOTSTRAP_PASSWORD` | no (default `admin`) | Password for the seed user; forced password-change on first login. |
| `NODE_ENV` | no (default `production`) | `development` / `production` / `test`. |

Deploy-plumbing vars (`WEB_IMAGE`, `CADDY_IMAGE`, `PORT`, `NEXT_HOST`/`NEXT_ALIAS`, `POSTGRES_*`) live in `.env` for the compose stack — see `.env.example`. There are intentionally **no** `WATCHTOWER_*` vars (see Deployment).

## Usage

### Authentication & re-auth

- **Username + password** (argon2id) — no OAuth or third-party identity providers. Login is rate-limited before the password check so brute-forcers can't even burn hashing CPU, and unknown usernames still pay the hashing cost to avoid timing/enumeration leaks.
- **JWT session**: `jose` HS512 token in a `__Host-session` cookie (HttpOnly, Secure, SameSite=Lax), with a server-side `jti` row in `web_sessions` for revocation and a sliding ~3-day TTL. A password change since a token was issued invalidates that token.
- **Re-auth (step-up) password**: a separate `users.reauth_password_hash`. Successful re-auth mints a new JWT carrying an `elevatedUntil` claim (valid ~10 min). Elevation is required to reveal or change any stored secret, change the account or re-auth password, or delete the account.

### Feeds → routes → destinations → sinks

1. **Feed** — an RSS source (label + URL + poll interval + backfill mode). The only inbound source type today.
2. **Route** — connects a feed to one or more **destinations**.
3. **Destination** (`route_destinations`) — `(sink_type, sink_id)` plus a per-row `destination` address. Email sinks (SMTP/Resend) require the `destination`; ntfy and `discord_webhook` carry their address on the sink itself. Each destination is independently `enabled`, so you can mute one without deleting it.
4. **Sink** — the configured channel/credential: `sinks_smtp`, `sinks_resend`, `sinks_ntfy`, `sinks_discord_webhook`. Secrets on sinks are encrypted at rest.

Notification bodies are built per sink type: SMTP/Resend get both plain-text and sanitized HTML, ntfy gets trimmed plain text, Discord gets a rich embed (or markdown when embeds are off). A **"Send latest"** button on each destination previews the exact final rendering using the same builders the dispatcher uses.

### Dispatch, retry & audit

- Every (feed item × destination) becomes one `dispatches` row. State machine: `pending → sent | failed | skipped`.
- Transient failures (network, 5xx) bump an attempts counter and reschedule with **exponential backoff**; unrecoverable errors (auth-failed, incomplete sink) go straight to `failed`. The last error message is stored on `dispatches.error` and surfaced in the UI with a manual **Retry** button — failures never disappear silently.
- **SSRF guard** (`web/src/lib/ssrf.ts`): every user-controlled outbound URL is checked against loopback, link-local, RFC1918 private ranges, IPv4-mapped IPv6, and the `169.254.169.254` cloud-metadata endpoint — including a re-check after DNS resolution to defeat split-horizon DNS.
- **Postgres Row-Level Security** on every user-data table: each web query runs in a transaction whose first statement is `SET LOCAL app.current_user_id`. The worker connects as a separate Postgres role (the table owner) that bypasses RLS at the GRANT level, not in application code.
- **Audit log**: every state-changing route calls `writeAudit({ actor, action, target_type, target_id, before, after, via })`. Stored secrets are always substituted with `[REDACTED]` in `before`/`after`.
- **Rate limiting** is a Postgres sliding-window applied per handler — not a wrapper middleware. The primitives are `rateLimit(key, opts)` and `rateLimitAll(checks)` in `web/src/lib/ratelimit.ts`. Authenticated routes use `withAuth(handler, { rateLimitPerUser, rateLimitPerIp })`, which calls `rateLimit()` internally (defaults 120/min per user, 600/min per IP); sensitive endpoints (login, re-auth, password change, test-send) call `rateLimit()` / `rateLimitAll()` directly with stricter buckets.

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
