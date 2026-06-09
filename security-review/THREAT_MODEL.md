# Threat Model — simple-rss-notifications

Scope: internet-facing, multi-user, hostile-user-exposed. Ingress is Cloudflare Tunnel → Caddy → Next.js `web`; a `worker` polls arbitrary user URLs and fans out to user-configured sinks.

## Assets
- **Stored third-party secrets** (SMTP password, Resend API key, ntfy token, Discord webhook URL) — encrypted at rest with AES-256-GCM (`APP_ENCRYPTION_KEY`).
- **User credentials** — argon2id password hashes; JWT session secret (`SESSION_SECRET`).
- **Per-user data isolation** — feeds, routes, sinks, dispatches, audit log (Postgres RLS).
- **The internal network** — `db:5432`, `web:3000`, host loopback, cloud metadata `169.254.169.254`.
- **The deploy pipeline** — GHCR `:latest` → watchtower → prod VPS.

## Trust boundaries
1. Internet → Cloudflare → Caddy → web (authn boundary: `__Host-session` JWT + `withAuth`).
2. web → Postgres: `withUser()` demotes to `web_role`; RLS enforces per-user rows. Owner connection only for pre-auth (login) and admin flows.
3. worker → external hosts: **every outbound URL is attacker-influenced** → `safeFetch`/`isPrivateHost` is the SSRF boundary.
4. CI/CD: PR (untrusted) vs `main` push (privileged, GHCR push) — GHCR creds only on `push: main`.

## Attackers & abuse cases
| Attacker | Capability | Mitigation (post-review) |
|---|---|---|
| Anonymous internet | hit any endpoint | `withAuth` (was bypassed → **fixed H1**); rate limits; middleware redirect |
| Authenticated tenant A | act on tenant B's data | RLS (verified sound); no IDOR |
| Authenticated tenant | point us at internal services | `safeFetch` IP-pin + redirect re-validate + SMTP guard (**fixed H2/H3/M2/M3**) |
| Malicious feed author | inject into subscribers' dashboards | `isSafeHttpUrl` href gate + CSP (**fixed M5/M6**); no `dangerouslySetInnerHTML`; output auto-escaped |
| Token thief (stolen JWT) | replay after logout/pw-change | jti revocation + `password_changed_at` now enforced (**fixed H1/M4**) |
| Session hijacker | overwrite stored secrets | **residual M1** — no re-auth gate yet |
| CI/CD abuser | ship unverified/poisoned image | deploy quality gate (**fixed H5**); GHCR creds not exposed to fork PRs |
| Secret-in-git | exfiltrate committed secret | none found; gitleaks added |

## Data flows (sensitive)
- **Login:** browser → `/api/auth/login` (rate-limited 5/min IP + 10/hr user, generic 401, argon2id, dummy-hash timing) → `__Host-session` JWT + `web_sessions` jti row.
- **Authed write:** browser → `withAuth` (jti+pwchanged+CSRF+ratelimit) → handler → `withUser`(RLS) → DB → `writeAudit` (secrets `[REDACTED]`).
- **Feed poll:** worker → `safeFetch(feedUrl)` (resolve-once, pin IP, manual redirect re-validate, 5 MiB cap) → parse (hand-rolled, no XML lib) → store → dispatch to sinks.

## High-risk components & blast radius
- `lib/ssrf.ts` (now the single chokepoint for all outbound HTTP) — a bug here re-opens SSRF to IMDS/DB. Mitigated by unit tests + manual redirect bounds.
- `lib/auth/withAuth.ts` + `session.ts` — auth boundary for the whole API.
- `worker` (BYPASSRLS role) — cross-user visibility by design; never exposed to web requests.
- Deploy pipeline — compromise = unattended prod RCE; mitigated by quality gate (signing/digest pinning = documented follow-up).

## Residual / accepted risk
M1 (re-auth elevation) and the Low items (L1/L2/L6/L7/L8) are documented and deferred by maintainer scope decision (High+Medium pass). `drizzle-orm` advisory tracked as a separate regression-tested bump.
