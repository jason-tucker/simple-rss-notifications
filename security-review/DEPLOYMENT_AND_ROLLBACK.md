# Deployment & Rollback

## Current status: NOT deployed
Delivered as **one consolidated PR** (`claude/beautiful-keller-6v9vrj` → `main`) per maintainer decision. No production deploy was performed. Production ships only when the PR is **merged to `main`** (CI builds + pushes `:latest`/`v0.15.0` to GHCR → host watchtower auto-pulls within ~30s).

## Pre-merge gates (all green)
- `pnpm typecheck` ✅ · `pnpm test` (8/8) ✅ · `pnpm build` ✅ · runtime e2e ✅ (TEST_RESULTS.md)
- After H5/M8: the deploy workflow now runs a typecheck+build `quality` job that `build-and-push` `needs:` — so even on merge, an image is not published unless it builds.

## Required before merging to `main`
1. **Review the diff** (41 files; +1718/−1277). This pass changes auth behavior (sessions now actually revoke) and routes all outbound HTTP through `safeFetch` — exercise a real feed/sink in staging if possible.
2. **Set `BOOTSTRAP_PASSWORD`** in the deploy `.env` for any *fresh* install (install.sh now generates one). Existing installs are unaffected by env but — see #3.
3. **Rotate the existing admin password** if your live instance was ever bootstrapped on `tucker`/`admin` (this change does NOT retroactively fix an already-seeded weak admin).
4. **Enable branch protection** on `main` to *require* CI status checks (the workflow gate blocks the deploy push, not the merge itself).
5. Confirm the pinned base-image patch tags resolve in your registry (the review container had no registry egress).

## Migration safety
Migrations `0000–0011` are unchanged; **no new migration** is introduced in this pass (the optional `users` column-GRANT hardening was deferred). Nothing destructive runs. No backup is required beyond your normal cadence.

## Rollback
Standard for this stack (immutable image tags are produced per build):
1. **Fastest:** repoint the deployed `.env`/compose `WEB_IMAGE`/`CADDY_IMAGE` from `:latest` to the previous immutable tag (e.g. `sha-<prev>` / `v0.14.0`) and `docker compose up -d` (or let watchtower settle), restoring the prior `web`+`worker` image. Save the current digest first (`docker inspect ... --format '{{.Image}}'`).
2. **Git:** revert the merge commit on `main`; CI rebuilds the prior code as a new `:latest`.
3. **No data rollback needed** — schema is unchanged.

Health: after deploy, the new container healthchecks (added this pass) gate readiness; verify `GET /login` returns 200 and the footer shows `v0.15.0 · <sha>`.

## If you want me to proceed
Say so explicitly and I will (a) open/refresh the PR, and (b) optionally watch CI and autofix failures. I will **not** merge to `main` or trigger the prod auto-pull without your explicit instruction.
