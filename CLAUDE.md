# simple-rss-notifications — AI Coding Instructions

These instructions apply to Claude Code and any AI coding tool working in this repo.

---

## Agent usage

Always spawn agents to do work. Haiku for lookups. Sonnet for coding. Opus for planning.

Use agents proactively — delegation is the default, not a fallback. Match the model to the task:

- **Haiku** — file discovery, repository searches, quick lookups, lightweight analysis, and simple verification.
- **Sonnet** — coding, implementation, refactoring, debugging, writing tests, editing documentation, and normal technical work.
- **Opus** — architecture, complex planning, cross-repository strategy, high-risk changes, difficult debugging strategy, and final reconciliation.

How to delegate well:

- Run independent work in parallel; serialize only when there is a real dependency.
- Give every delegated task a precise scope and a concrete expected output.
- Require every agent to cite the paths, symbols, commands, or repository evidence behind its conclusions.
- Demand actionable results, not generic summaries.
- Never let two agents edit the same file at once — assign explicit file ownership and coordinate overlaps through the orchestrator.
- Resolve conflicting recommendations with repository evidence, not preference.
- Validate every agent's output before accepting it; re-run or re-scope on doubt.
- Use agents to improve speed or quality — not to create pointless duplication.
- The orchestrator reviews all delegated work and remains responsible for final correctness.

To validate without OOMing the VPS (rule 2 bans `pnpm typecheck`/`tsc`/`next build` there): `pnpm test` is safe to run locally — it uses tsx + Node's test runner, no full build.

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
Every write API route calls `writeAudit({actor_user_id, action, target_type, target_id?, before?, after?, via: 'web', ip?})`. Stored secrets (SMTP password, Resend key, ntfy token) are NEVER included in `before`/`after` — substitute `[REDACTED]`.

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
Adding/editing/deleting feeds, routes, sinks, or credentials in the UI must NOT require restarting any container. The worker `LISTEN`s on `pg_notify('feeds_changed', …)` (feed/route/destination CRUD) and `pg_notify('dispatches_changed', …)` (retry button) and additionally falls back to a 5-second safety-net poll (`IDLE_SLEEP_MS`) as a backstop. See `lib/db/notify.ts` (emitters) and `worker/notify.ts` + `worker/index.ts` (subscriber + loop).

### 11. Rate limit every API route
Authenticated routes get a per-user + per-IP limit via `rateLimit()` invoked inside `withAuth()`; sensitive unauthenticated handlers (login/reauth/password-change) call `rateLimit()` / `rateLimitAll()` directly with stricter buckets. There is no `withRateLimit` wrapper. See `lib/ratelimit.ts`.

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
- **Postgres RLS** on every user-data table, keyed on `current_setting('app.current_user_id')`. Web queries that touch user data go through `withUser(userId, fn)` (`web/src/lib/db/withUser.ts`), which opens a transaction and issues `SET LOCAL ROLE web_role` followed by `SELECT set_config('app.current_user_id', '<uuid>', true)` — this demotes the connection out of owner privileges for the duration of the transaction so RLS policies apply. Outside `withUser` (admin/login flows with no userId yet) the connection remains as owner. The worker connects as the DB owner; because `FORCE ROW LEVEL SECURITY` is NOT enabled, the owner bypasses RLS by default — owner-level bypass, not a GRANT to a separate bypass role.

## Where to add things

| What | Where |
|---|---|
| New API route | `web/src/app/api/<resource>/route.ts` — wrap in `withAuth(handler, {requireElevated?, rateLimitPerUser?, rateLimitPerIp?})` (which applies the rate limit); unauthenticated routes call `rateLimit()` / `rateLimitAll()` directly |
| New page | `web/src/app/<area>/page.tsx` — gate via `getSession()` in the layout/page |
| New DB table | `web/src/lib/db/schema/<name>.ts` — add RLS policies in the migration |
| New worker task | `web/src/worker/<task>.ts` — register in `web/src/worker/index.ts` |
| New audit hook | `web/src/lib/audit.ts` — call `writeAudit({actor_user_id, action, target_type, target_id?, before?, after?, via?, ip?})` from the route handler |
| New admin-gated route | Use `requireAdmin()` from `web/src/lib/auth/admin.ts` (not `withAuth`); admin routes run as DB owner so they bypass RLS and can see/modify any user row — no `withUser` wrapper. See `/dashboard/admin/users` for the pattern |
| New env var | `web/src/lib/env.ts` (zod schema) + `.env.example` + `scripts/install.sh` if it needs auto-generation |

## Outbound HTTP — always use `safeFetch`

Every outbound HTTP call (RSS feeds, ntfy, Discord webhooks, Resend API, and any future sink or external URL) **must** go through `safeFetch()` from `web/src/lib/ssrf.ts` — never raw `fetch()`. `safeFetch` resolves the host once, pins the TCP connection to the validated IP (defeating DNS-rebinding/TOCTOU), follows redirects manually re-validating each `Location`, enforces an end-to-end timeout, and decodes gzip/deflate/br. Use `checkSafeOutboundUrl(url)` for API-route save-time validation of user-pasted URLs, and `isPrivateHost(host)` for the SMTP guard (no URL layer). New call sites that use raw `fetch()` instead of `safeFetch` will be treated as a security defect.

## Schema changes — migration guidance

The schema is owned by this repo. There are no SQL migration files in `.gitignore` — they are committed (`web/src/lib/db/migrations/0000–0011`).

To change the schema:

1. Edit the schema module(s) under `web/src/lib/db/schema/*.ts`.
2. `pnpm db:generate` — emits a reviewed `.sql` file under `web/src/lib/db/migrations/` plus a snapshot and journal entry.
3. **Inspect the generated `.sql`** (especially any `DROP` or column removal) before committing.
4. Commit the `.sql` and snapshot together with the schema change.
5. The migration runner (`tsx scripts/migrate.ts` = `pnpm db:migrate`) applies migrations forward-only. In production the **worker** applies pending migrations on boot (step 3 of its boot sequence); the web container never runs migrations.
6. Add **RLS policies** in the migration for any new user-data table (`web_role` RW GRANT + `CREATE POLICY` keyed on `app.current_user_id`).

**Never run `drizzle-kit push` in production** — it bypasses the forward-only migration log and can silently mutate tables.

## Local dev commands

From `web/`:

| Command | What it does |
|---|---|
| `pnpm dev` | Start the Next.js dev server on port 3000 |
| `pnpm test` | Run unit tests via tsx + Node's test runner — safe locally, no full build |
| `pnpm worker` | Run the worker locally via tsx (no build needed) |
| `pnpm db:generate` | Emit a new migration `.sql` from schema changes |
| `pnpm db:migrate` | Apply pending migrations against the DB in `DATABASE_URL` |

The full env-var list (enforced by zod on startup) is documented in `web/src/lib/env.ts` and `.env.example`. See also the **Configuration** section in `README.md`.

## Re-auth gate — deferred

The `withAuth` wrapper supports a `requireElevated` option that gates routes behind the re-auth password (`users.reauth_password_hash` → `elevatedUntil` JWT claim, 10-min window). The auth-model bullet above describes the intended semantics (revealing/changing stored secrets, changing account or reauth passwords, deleting the account). However, **`requireElevated` is not yet wired on any production route** — it is a security review deferred item (M1). Treat the "Required for:" list as forward-looking, not live. See `security-review/` for the full threat model and the list of deferred items.

## Deployment

- `main` branch → CI builds `ghcr.io/jason-tucker/simple-rss-notifications{,-web}:latest` → watchtower auto-pulls onto the prod VPS within ~30s.
- CI also tags `vX.Y.Z` after a successful build, pushed to the repo so releases are discoverable.
- The footer of every page displays `simple-rss-notifications v<package.json version> · <short SHA>` so you always know which build is running.
