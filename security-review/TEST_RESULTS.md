# Test Results — Security & Hardening Pass

All commands run on the integrated branch `claude/beautiful-keller-6v9vrj` in the review container (Node 22.22, pnpm 10.33, PostgreSQL 16 installed via apt — Docker daemon was unavailable, so a native cluster was used). 15 GiB RAM, so `next build` did not OOM (the CLAUDE.md §2 OOM caveat is about the small prod VPS).

## Static / unit

| Command | Result | Notes |
|---|---|---|
| `pnpm install --frozen-lockfile` | ✅ pass | integrated lockfile (post nodemailer/esbuild/next bumps) |
| `pnpm typecheck` (`tsc --noEmit`) | ✅ pass | clean after 2 integration fixes (unused `@ts-expect-error`, `.ts` import) |
| `pnpm test` (`node --conditions=react-server --import tsx --test`) | ✅ 8/8 pass | see below |
| `pnpm build` (`next build` + worker esbuild) | ✅ pass | 884 kB worker bundle; all routes compiled |
| `pnpm audit` | ◑ 9 → 1 | 1 residual HIGH = `drizzle-orm < 0.45.2` (deferred) |

### Unit tests (8/8)
```
ok 1 - isPrivateAddress rejects private/reserved/internal addresses   (10/8,127/8,169.254,172.16/12,192.168,CGNAT,::1,::ffff:7f00:1,64:ff9b::,2002::)
ok 2 - isPrivateAddress accepts public addresses
ok 3 - isPrivateAddress treats garbage as unsafe
ok 4 - isPrivateHost resolves literal IPs directly
ok 5 - isSafeHttpUrl rejects dangerous schemes   (javascript:, data:, vbscript:, file:, case/whitespace/control tricks)
ok 6 - isSafeHttpUrl accepts http and https
ok 7 - isSafeUrl rejects dangerous schemes
ok 8 - isSafeUrl accepts http(s), mailto, and relative
# tests 8 # pass 8 # fail 0
```

## Runtime end-to-end (Postgres + migrate + built worker + `next start` + curl)

Bootstrap seeded `tucker` (is_admin, must_change_password) with a **strong** password — confirming the default-cred fix permits non-`admin` and would refuse `admin`.

| # | Assertion | Expected | Actual | Verdict |
|---|---|---|---|---|
| 1 | `GET /api/feeds` no session | denied | `307 → /login` (middleware) | ✅ denied (pre-existing redirect) |
| 2 | `POST /api/auth/login` (valid, Origin set) | 200 + cookie | `200`, `__Host-session` present | ✅ |
| 3 | `GET /api/feeds` with valid session | 200 | `200` | ✅ |
| 4 | `POST /api/auth/logout` | 200 | `200` | ✅ |
| 5 | **`GET /api/feeds` with the now-logged-out cookie** | 401 | `401 {"code":"session-revoked"}` | ✅ **headline H1 fix** |
| 6 | `POST /api/feeds` `url=http://169.254.169.254/...` | 4xx ssrf | `400 {"code":"ssrf-blocked","error":"IP 169.254.169.254 is private/reserved"}` | ✅ **H2/H3** |
| 7 | `POST /api/feeds` with `Origin: https://evil.example` | 403 csrf | `403` | ✅ |
| 8 | `GET /api/dispatches` ×14 (default 120/min) | all 200 | `200`×14 | ✅ limiter wired, no false-trip |
| 9 | 8× bad login from one IP (bucket 5/min) | 429 appears | `401 401 401 429 429 429 429 429` | ✅ **rate-limit returns 429** |
| 10 | Security headers on `/login` | CSP + XFO + nosniff + HSTS + Referrer + Permissions | all present | ✅ **M6 / headers** |

## What was NOT executed (and why)
- **DAST / ZAP** — no scanner available in-container; not run against a non-public target.
- **Load/perf benchmarks** — out of scope for this pass; reliability fixes (body caps, bounded redirects, timeouts) were code-reviewed.
- **Worker→safeFetch redirect path at runtime** — exercised via the save-time SSRF check (e2e #6) + IP-classifier unit tests rather than a live malicious redirect server.
- **Docker image build** — Docker daemon unavailable; `next build` + native Postgres used instead. Base-image patch tags should be confirmed against the registry in CI.
