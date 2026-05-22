/**
 * Worker entrypoint. Same image as the web container; the `SRN_ROLE=worker`
 * env var and the compose `command:` override route us here instead of the
 * Next.js HTTP server.
 *
 * Boot sequence:
 *   1. Validate env (lib/env.ts refuses to start on missing secrets).
 *   2. Connect to Postgres as worker_role (BYPASSRLS).
 *   3. Apply pending migrations.
 *   4. Upsert a heartbeat row every 30s — web reads it for the
 *      /api/health/worker check.
 *
 * v0.2.0 scope ends here. Real responsibilities land PR-by-PR:
 *   PR6 — Postgres LISTEN/NOTIFY + 60s safety-net poll
 *   PR7 — RSS poller (per-feed cadence, ETag/304, dedup, retry-on-boot)
 *   PR10 — ntfy SSE subscriber (long-lived per topic, exp backoff reconnect)
 */

import { sql } from 'drizzle-orm'
import { env } from '@/lib/env'
import { BUILD_VERSION, GIT_SHA } from '@/lib/version'
import { db, pg } from '@/lib/db/client'
import { runMigrations } from '@/lib/db/migrate'
import { bootstrap } from './bootstrap'

const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_ID = 'singleton'

let shuttingDown = false

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), role: 'worker', msg, ...extra }))
}

async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  log('shutdown', { signal })
  try { await pg.end({ timeout: 5 }) } catch { /* ignore */ }
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT',  () => { void shutdown('SIGINT')  })
process.on('unhandledRejection', (reason) => { log('unhandled-rejection', { reason: String(reason) }); process.exit(1) })
process.on('uncaughtException',  (err)    => { log('uncaught-exception',  { err: err.message })       ; process.exit(1) })

async function beat() {
  // Upsert keyed by 'singleton' — exactly one heartbeat row regardless of
  // how many times the worker restarts. last_beat_at is read by
  // /api/health/worker to detect a stuck/dead worker.
  await db.execute(sql`
    INSERT INTO worker_heartbeats (id, last_beat_at, build_version, git_sha)
    VALUES (${HEARTBEAT_ID}, now(), ${BUILD_VERSION}, ${GIT_SHA})
    ON CONFLICT (id) DO UPDATE SET
      last_beat_at = excluded.last_beat_at,
      build_version = excluded.build_version,
      git_sha = excluded.git_sha
  `)
}

async function main() {
  log('boot', { version: BUILD_VERSION, sha: GIT_SHA, role: env.SRN_ROLE })

  // Migrations — only the worker runs these. Web containers never touch DDL.
  await runMigrations()
  log('migrations-applied')

  // Bootstrap the admin user on a fresh DB. Idempotent: subsequent boots
  // see app_meta.bootstrap_completed_at and skip.
  await bootstrap(log)

  // Heartbeat loop. If a beat fails we log but keep looping — a transient
  // Postgres blip should not kill the worker. If beats fail repeatedly the
  // /api/health/worker check will flag the staleness and the UI banner
  // surfaces it.
  while (!shuttingDown) {
    try {
      await beat()
      log('heartbeat', { uptimeSec: Math.floor(process.uptime()) })
    } catch (err) {
      log('heartbeat-failed', { err: err instanceof Error ? err.message : String(err) })
    }
    await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL_MS))
  }
}

main().catch((err) => {
  log('fatal', { err: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
