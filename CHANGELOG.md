# Changelog

All notable changes to this project. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 minor bumps land per merged PR; patch bumps for fix-only PRs.

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
