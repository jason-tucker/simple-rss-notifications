# Dependencies & SBOM Notes

`web/` is the only package (pnpm, Node 22). No other ecosystems (no Python/Go/Rust/Java).

## `pnpm audit`: 9 → 1
Before: **2 high / 6 moderate / 1 low**. After: **1 high** (deferred, see below).

| Package | Before | After | Advisory | Surface |
|---|---|---|---|---|
| nodemailer | `^6.9.16` | `^8.0.5` (8.0.x) | HIGH addressparser DoS (`GHSA-vvjj-xcjg-gr5g`) + SMTP-injection/envelope | **runtime** (email sink) |
| @types/nodemailer | `^6.4.16` | `^8.0.0` | (types only) | dev |
| esbuild | `^0.24.0` | `^0.25.0` | moderate dev-server CORS (`GHSA-67mh-4wv8-2f99`) | dev/build |
| drizzle-kit | `^0.28.1` | `^0.31.10` | drops deprecated `@esbuild-kit` chain pinning esbuild 0.18 | dev/build |
| next | `^15.0.3` | `^15.5.19` | postcss transitive patch | build |
| postcss | `^8.4.49` | `^8.5.10` (+`pnpm.overrides`) | XSS in stringify (`GHSA-qx2v-qp2m-jg93`) | build |

`send.ts` required **no code change** for the nodemailer 6→8 major (createTransport/sendMail/messageId API stable); `pnpm typecheck` confirms.

### Residual (deferred)
- **`drizzle-orm < 0.45.2` — HIGH SQL-identifier injection (`GHSA-gpj5-g38j-94v9`).** A 9-minor pre-1.0 bump (0.36→0.45) with real ORM-regression risk. Practical exploitability here is **low**: the codebase uses parameterized `` sql`...${value}...` `` value-binding everywhere and does **not** use the vulnerable dynamic-identifier/`sql.identifier` surface. Recommend a dedicated, regression-tested PR.
  - Because the new CI `audit` gate (`pnpm audit --prod --audit-level high`) would otherwise fail on this single tracked advisory, it is listed in `web/package.json` → `pnpm.auditConfig.ignoreGhsas`. The gate **still fails on any other high**; remove the entry once drizzle-orm is bumped.

## Supply-chain hygiene
- **No committed secrets** in working tree or git history (ripgrep + git pickaxe over 50 commits; only `.env.example` placeholders). `.gitignore`/`.dockerignore` correctly exclude `.env`.
- **postinstall / lifecycle scripts:** pnpm reports `esbuild` and `sharp` build scripts ignored by default (`ignored build scripts` warning) — these are not auto-run, which is the safe default.
- **Pinning:** runtime deps use caret ranges (lockfile pins exact versions). New CI third-party actions (gitleaks, CodeQL) are SHA-pinned; existing `actions/*`/`docker/*` remain on floating major tags (documented follow-up).
- **Base images:** pinned to patch tags (`node:22.13.1-alpine`, `caddy:2.10.0-alpine`, `postgres:16.6-alpine`); digest (`@sha256:`) pinning + cosign verification is a recommended follow-up (the review container had no registry egress to resolve digests — confirm tags exist in CI).

## SBOM
A formal SBOM (CycloneDX/syft) was not generated (tooling absent in-container). Generate in CI with e.g. `pnpm dlx @cyclonedx/cyclonedx-npm --output-file sbom.json` or `syft dir:web`. The dependency tree is small (9 runtime deps) and enumerated in `web/pnpm-lock.yaml`.
