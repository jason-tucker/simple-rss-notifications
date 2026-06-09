# Security Changelog — v0.15.0 (2026-06-09)

Security-relevant changes only (full list in repo `CHANGELOG.md`). Maps each change to its finding ID (see SECURITY_REVIEW_REPORT.md).

## Fixed — High
- **H1** Session revocation enforced on all data API routes (`withAuth` wired in). Logout / "logout everywhere" / password change now invalidate live JWTs; per-user + per-IP rate limits applied. *Runtime-verified: revoked cookie → 401.*
- **H2/H3** SSRF guard rebuilt as `safeFetch` — resolves once, pins the TCP connection to the validated IP (defeats DNS rebinding/TOCTOU), and re-validates every redirect hop (defeats redirect→IMDS/internal).
- **H4** Default `tucker`/`admin` bootstrap credentials eliminated; weak/`admin` password refuses to seed; install.sh generates a strong one.
- **H5** Production deploy gated on typecheck+build; unverified code can no longer reach GHCR/watchtower.

## Fixed — Medium
- **M2** SMTP sink SSRF-guarded (`isPrivateHost`) + generic connection error (kills internal port-scan oracle).
- **M3** IPv6 SSRF allowlist gaps closed (NAT64, 6to4, hex IPv4-mapped, ULA, link-local, multicast) via byte-level classification.
- **M4** Admin password reset deletes the target's sessions; `requireAdmin` performs jti revocation.
- **M5** Stored XSS via feed `item_link` closed — `isSafeHttpUrl` allowlist at ingest + render.
- **M6** Content-Security-Policy added (backstop).
- **M7** Vulnerable deps upgraded (nodemailer HIGH cleared); `pnpm audit` 9→1.
- **M8** CI gains `pnpm audit` + gitleaks + CodeQL + Dependabot.
- **M9/M10/M11** Container hardening: resource limits, `cap_drop: ALL`, `no-new-privileges`, healthchecks, patch-pinned images.

## Fixed — Low
- **L3** `dispatches` pagination total honours the `feed_id` filter.
- **L4** ntfy `Click` header sanitized + http(s)-gated.
- **L5** Provider error bodies read with an 8 KiB cap.

## Deferred (documented)
- **M1** re-auth elevation for secret mutation (UI feature).
- **INF** `drizzle-orm ≥ 0.45.2` (own regression PR).
- **L1** CSRF fail-closed, **L2** drop `x-forwarded-for` trust, **L6** `users` column GRANT, **L7** seeded maintainer SMTP sink, **L8** install.sh entropy assertion; CSP nonce pipeline; image digest pinning + cosign.

## Operator actions required
Rotate any existing `admin` bootstrap password · set `BOOTSTRAP_PASSWORD` on fresh installs · enable `main` branch protection · confirm base-image tags in your registry.
