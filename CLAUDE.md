# simple-rss-notifications — AI Coding Instructions

These instructions apply to Claude Code and any AI coding tool working in this repo.

---

## Mandatory rules

### 1. Always update CHANGELOG.md
Every meaningful change adds a line under a **real semver heading**, NOT under `## [Unreleased]`. If your PR is the first change since the last release, create the next section: `## [0.2.0] — YYYY-MM-DD` at the top of the file. Bump `web/package.json` "version" in the same commit.

### 2. Never run TypeScript compilation on the VPS
`pnpm typecheck` / `tsc` / `next build` OOM the VPS. Run those in CI only. Describe suspected type errors in text instead. Same goes for `pnpm install` on the VPS — pnpm install during deploy happens inside the docker build, not on the host.

### 3. No host ports, ever
Every container talks over the docker network. Cloudflare Tunnel is the only ingress. The only `ports:` entry in `docker-compose.yml` is the loopback bind `127.0.0.1:${PORT}` for Caddy so cloudflared on the host can reach us. If you find yourself writing `ports: ["x:y"]` (0.0.0.0), STOP and use `expose:` + network aliases instead.

### 4. Hostname is env-configurable
The app never hardcodes a domain. `PUBLIC_BASE_URL` env (set at deploy time) is the source of truth for cookie domain, CSRF origin check, OAuth redirect URI (future), etc.

### 5. Audit every state-changing action
Every write API route calls `writeAudit({actor, action, target_type, target_id, before, after, via: 'web'})`. Stored secrets (SMTP password, Resend key, ntfy token) are NEVER included in `before`/`after` — substitute `[REDACTED]`.

### 6. Main-only branching
All feature work targets `main` directly via PRs.

1. Branch from `main` (or `origin/main`), do the work, push, open PR with `gh pr create --base main`.
2. CI runs `pnpm typecheck` + `pnpm build` on every PR (no GHCR push on PRs).
3. Merge to `main` → CI builds + pushes `ghcr.io/jason-tucker/simple-rss-notifications{,-web}:latest` and tags `v<x.y.z>` → watchtower auto-pulls onto the prod VPS within ~30s.

### 7. Project board card per PR
Every PR has a card on the [simple-rss-notifications Project board](https://github.com/users/jason-tucker/projects/6). Create the card before opening the PR; link them via `gh project item-add`.

### 8. No hardcoded secrets, no `.env` in git
Secrets live in `.env` (gitignored) or in the DB encrypted at rest with AES-256-GCM. The app refuses to start if `SESSION_SECRET` or `APP_ENCRYPTION_KEY` is missing — `lib/env.ts` enforces this via zod.

### 9. Commit often
Small, frequent commits with clear messages. Do not batch a day's work into one giant commit. Each commit message starts with a verb in present tense ("add", "fix", "wire up", "rate-limit"…).

### 10. Dynamic config — no restarts
Adding/editing/deleting feeds, routes, sinks, or credentials in the UI must NOT require restarting any container. The worker reacts to `pg_notify('config_changed', …)` and additionally falls back to a 60-second `updated_at > worker_last_tick` poll.

### 11. Rate limit every API route
Every API handler is wrapped in `withRateLimit(handler, {bucket, limit, windowMs})`. Login/reauth/password-change use stricter limits than authenticated GETs. See `lib/ratelimit.ts`.

### 12. Error handling beyond happy path
Every external call (HTTP fetch, SMTP send, Resend API, ntfy fetch, DB write) is wrapped in try/catch with structured logging. Failures surface to the user via the `dispatches.error` column and a retry button — they never fail silently.

---

## Architecture overview

```
internet → Cloudflare Tunnel → cloudflared (standalone, host network, NOT in compose)
                                    ↓ ingress rule → http://localhost:6082
                                caddy (compose, 127.0.0.1:6082 loopback)
                                    ├─ on 5xx → landing/502.html
                                    └─ reverse_proxy → web:3000
                                                          ↓ docker network srn-net
                                                         db (Postgres 16)
                                                          ↑
                                                       worker  (same image as web,
                                                                command=node dist/worker/index.js,
                                                                SRN_ROLE=worker)
```

### Why cloudflared is standalone, not in compose
Compose `up -d` recreates containers whenever the compose file or env changes. cloudflared's `TUNNEL_TOKEN` is baked in at container-create time; a recreate would wipe it and the tunnel would go dark. cloudflared lives at `/home/botuser/cloudflared/` on the host, run as a `docker run --network host` container.

### Why web and worker are separate containers
- Web restarts (every deploy) don't bounce in-flight RSS dispatches.
- Horizontally scaling `web` later wouldn't double-poll feeds.
- Both share the same source tree and same image; the `SRN_ROLE` env var + the `command:` override decide which entrypoint runs.

## Stack (locked)

- Next.js 15 App Router · React 19 · TypeScript · Tailwind · shadcn/ui
- Drizzle ORM · postgres-js · zod · jose (JWT) · @node-rs/argon2 · nodemailer
- Caddy 2 in front · cloudflared for ingress

## Auth model

- **Username + password** (argon2id) — no OAuth, no third-party auth providers.
- **JWT session** (jose HS512, `__Host-session` cookie, sliding 3-day TTL, server-side `jti` mirror in `web_sessions` for revocation).
- **Re-auth password** — separate `users.reauth_password_hash`. Successful reauth mints a new JWT with `elevatedUntil` claim valid 10 min. Required for: revealing or changing any stored secret, changing the account password, changing the reauth password itself, deleting account.
- **Postgres RLS** on every user-data table, keyed on `current_setting('app.current_user_id')`. Every web query runs in a transaction whose first statement is `SET LOCAL app.current_user_id = $1`. The worker runs as a separate Postgres role that bypasses RLS (GRANT-level, not application-level).

## Where to add things

| What | Where |
|---|---|
| New API route | `web/src/app/api/<resource>/route.ts` — wrap in `withAuth(handler, {requireElevated?})` and `withRateLimit(...)` |
| New page | `web/src/app/<area>/page.tsx` — gate via `getSession()` in the layout/page |
| New DB table | `web/src/lib/db/schema/<name>.ts` — add RLS policies in the migration |
| New worker task | `web/src/worker/<task>.ts` — register in `web/src/worker/index.ts` |
| New audit hook | `web/src/lib/audit.ts` — call `writeAudit({...})` from the route handler |
| New env var | `web/src/lib/env.ts` (zod schema) + `.env.example` + `scripts/install.sh` if it needs auto-generation |

## Deployment

- `main` branch → CI builds `ghcr.io/jason-tucker/simple-rss-notifications{,-web}:latest` → watchtower auto-pulls onto the prod VPS within ~30s.
- CI also tags `vX.Y.Z` after a successful build, pushed to the repo so releases are discoverable.
- The footer of every page displays `simple-rss-notifications v<package.json version> · <short SHA>` so you always know which build is running.
