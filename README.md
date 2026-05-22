# simple-rss-notifications  ·  *Euphoric Notify*

> Branded as **Euphoric Notify** (sibling to Euphoric FM and Euphoric Media).
> The GitHub repo / package / Docker image names stay `simple-rss-notifications`
> for stability; everything user-facing in the UI shows the Euphoric Notify
> brand.

A self-hosted, multi-user notification bridge that turns **RSS feeds → email or ntfy**, and **ntfy → email**. Configuration is entirely UI-driven — no editing files on the server, no restarts when you add a feed or change a credential.

## Status

Active. See [CHANGELOG.md](./CHANGELOG.md) for what's shipped. PR-by-PR plan tracked on the [project board](https://github.com/users/jason-tucker/projects/6).

## What it does (target)

- **RSS → email** (SMTP or Resend)
- **RSS → ntfy** (any ntfy server + topic, optional bearer token)
- **ntfy → email** (subscribe to a topic, forward each message as an email)
- Inbound email (email → ntfy) is planned for v2.

Backfill control on every new feed: `none` / `last N posts` / `last X days`, with optional pacing so you don't get blasted with 200 emails when adding a new feed.

## Architecture

```
internet → Cloudflare Tunnel → cloudflared (standalone container, host network)
                                    ↓ → 127.0.0.1:6082
                                  caddy ──→ web:3000  (Next.js dashboard + API)
                                              ↓
                                            db (Postgres 16)
                                              ↑
                                            worker  (same image, SRN_ROLE=worker,
                                                     LISTEN/NOTIFY + RSS poller +
                                                     ntfy SSE subscriber)
```

Why a separate worker container: web restarts (deploys) don't bounce in-flight RSS dispatches, and scaling web horizontally won't double-poll.

## Security posture

- All secrets in `.env` (gitignored) or encrypted at rest in the DB with AES-256-GCM (`APP_ENCRYPTION_KEY`).
- App **refuses to start** if `SESSION_SECRET` or `APP_ENCRYPTION_KEY` are missing — no silent fallback to insecure defaults.
- argon2id password hashing.
- JWT sessions in a `__Host-` prefixed cookie (HttpOnly, Secure, SameSite=Lax), server-side `jti` row in `web_sessions` for revocation, sliding 3-day TTL.
- **Re-auth password** gates viewing or changing any stored credential (SMTP password, Resend key, ntfy token, account password).
- Postgres Row-Level Security on every user-data table — every web query runs in a transaction that `SET LOCAL app.current_user_id`.
- Rate limiting on every API route (sliding window in Postgres).
- All RSS URLs pass an SSRF guard (no `127.0.0.1`, no `169.254.169.254`, no private ranges).
- All state-changing routes write an audit log row with `actor`, `action`, `before`, `after`.

Cloudflared sits in front but the app does **not** rely on it for authentication — assume zero trust at the cloudflared boundary.

## Install (VPS)

One-shot:

```bash
GITHUB_OWNER=jason-tucker bash <(curl -fsSL https://raw.githubusercontent.com/jason-tucker/simple-rss-notifications/main/scripts/install.sh)
```

The script clones to `~/projects/simple-rss-notifications`, generates random secrets, opens `.env` in `nano` for you to set `PUBLIC_BASE_URL`, then `docker compose up -d`.

## Local development

```bash
git clone https://github.com/jason-tucker/simple-rss-notifications
cd simple-rss-notifications/web
pnpm install
pnpm dev   # http://localhost:3000
```

Database via the compose stack: `docker compose up -d db`.

## CHANGELOG + versioning

Every merged PR bumps `web/package.json` "version" and adds a real semver section to [CHANGELOG.md](./CHANGELOG.md). The footer of every page displays the running version + short git SHA. No `[Unreleased]` headings.

## Project plan + tracking

- Plan: PR-by-PR sequencing lives in the GitHub Project board: <https://github.com/users/jason-tucker/projects/6>
- Issues + PRs: <https://github.com/jason-tucker/simple-rss-notifications>
- Wiki: setup, security model, troubleshooting — populated in PR12.
