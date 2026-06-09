# Remediation Plan & Status

Work was decomposed into **8 file-disjoint units**, each implemented in an isolated git worktree by a parallel agent, then integrated onto `claude/beautiful-keller-6v9vrj`. No two units touched the same file (verified), so integration was conflict-free. CHANGELOG/version bumped once at integration (CLAUDE.md §1).

| Unit | Branch | Findings addressed | Files | Status |
|---|---|---|---|---|
| Wire `withAuth` across data routes (+ dispatches count) | `claude/sec-auth` | H1, L3 | `lib/auth/withAuth.ts` + 12 `app/api/**` routes | ✅ merged |
| SSRF `safeFetch` (pin/redirect/IPv6/SMTP/Click/caps) | `claude/sec-ssrf` | H2, H3, M2, M3, L4, L5 | `lib/ssrf.ts`, `rss/fetch.ts`, `ntfy/publish.ts`, `discord/webhook.ts`, `email/send.ts` | ✅ merged |
| Stored-XSS + CSP | `claude/sec-xss` | M5, M6 | `ActivityList.tsx`, `rss/parse.ts`, `rss/format.ts`, `lib/url.ts`, `next.config.mjs` | ✅ merged |
| Default-credentials | `claude/sec-creds` | H4 | `lib/env.ts`, `scripts/install.sh`, `.env.example`, `worker/bootstrap.ts` | ✅ merged |
| CI/CD hardening | `claude/sec-cicd` | H5, M8 | `deploy.yml`, `ci.yml`, `dependabot.yml` | ✅ merged |
| Dependency upgrades | `claude/sec-deps` | M7 | `web/package.json`, `pnpm-lock.yaml` | ✅ merged |
| Container hardening | `claude/sec-docker` | M9, M10, M11 | `docker-compose.yml`, `web/Dockerfile`, `Dockerfile` | ✅ merged |
| Admin session revocation | `claude/sec-admin` | M4 | `lib/auth/admin.ts`, `app/api/users/[id]/route.ts` | ✅ merged |

Integration fixes by coordinator: typecheck (`.ts` import, unused `@ts-expect-error`), `pnpm test` script + CI step, consolidated CHANGELOG/version, report docs.

## Deferred (by maintainer scope = High+Medium) — recommended follow-ups
1. **M1 — re-auth elevation** for secret mutation: add `/api/auth/reauth` minting `elevatedUntil`, mirror it server-side in `web_sessions`, wrap secret-writing sink `PATCH` in `withAuth(..., {requireElevated:true})`. UI password-prompt needed. **Highest-value remaining item.**
2. **INF — `drizzle-orm ≥ 0.45.2`** (GHSA-gpj5-g38j-94v9): own PR + regression test of all `sql\`\`` call sites.
3. **L1** CSRF fail-closed when Origin+Referer both absent (for write methods).
4. **L2** drop `x-forwarded-for` fallback in `clientIp()` (Cloudflare sets `cf-connecting-ip`).
5. **L6** column-level GRANT so `web_role` cannot UPDATE `users.is_admin`.
6. **L7** remove the seeded maintainer SMTP sink (`worker/bootstrap.ts`) or make it env-gated.
7. **L8** assert generated password length in the install.sh non-openssl fallback.
8. **CSP** nonce pipeline (drop `'unsafe-inline'`); **M9/M10** image digest pinning + cosign; SHA-pin the existing `actions/*`/`docker/*` tags.

## AI safety
**Not applicable** — the repository contains no LLM/embedding/RAG/agent/tool-calling/model-file code (no `openai`/`anthropic`/`langchain`/`genai`/model loaders in `package.json` or source). No `AI_SAFETY_REVIEW.md` produced.
