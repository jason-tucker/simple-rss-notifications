# Changelog

All notable changes to this project. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 minor bumps land per merged PR; patch bumps for fix-only PRs.

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
