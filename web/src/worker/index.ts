/**
 * Worker entrypoint. Same image as the web container; the `SRN_ROLE=worker`
 * env var and the compose `command:` override route us here instead of the
 * Next.js HTTP server.
 *
 * Boot sequence:
 *   1. Validate env (lib/env.ts refuses to start on missing secrets).
 *   2. Connect to Postgres as POSTGRES_USER (table owner, bypasses RLS).
 *   3. Apply pending migrations.
 *   4. Run idempotent bootstrap seeders.
 *   5. Loop forever:
 *        - try to poll one due feed (greedy drain — if work was done,
 *          immediately try the next one)
 *        - try to dispatch one pending dispatch (same greedy drain)
 *        - if nothing was due, sleep briefly
 *        - upsert heartbeat every 30 s on a separate timer
 *
 * v0.5.0 — polling + dispatch live. Real LISTEN/NOTIFY for instant
 * config propagation arrives in a later PR; for now the loop just polls
 * the DB each tick (cheap, no extra dep, ~1 query/2s).
 */

import { sql } from 'drizzle-orm'
import { env } from '@/lib/env'
import { BUILD_VERSION, GIT_SHA } from '@/lib/version'
import { db, pg } from '@/lib/db/client'
import { runMigrations } from '@/lib/db/migrate'
import { bootstrap } from './bootstrap'
import { pollOneDueFeed } from './rssPoller'
import { dispatchOnePending } from './dispatcher'
import { startNotifySubscriber, sleepUntilKickOrMs, type NotifySubscriber } from './notify'

const HEARTBEAT_INTERVAL_MS = 30_000
// Max time the work loop sleeps when nothing's pending. NOTIFY from the
// web side wakes us sooner — this is the safety-net interval for cron-
// triggered polling cadence and for catching feeds whose poll_interval_s
// just elapsed.
const IDLE_SLEEP_MS = 5_000
const ERROR_SLEEP_MS = 5_000
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
  await db.execute(sql`
    INSERT INTO worker_heartbeats (id, last_beat_at, build_version, git_sha)
    VALUES (${HEARTBEAT_ID}, now(), ${BUILD_VERSION}, ${GIT_SHA})
    ON CONFLICT (id) DO UPDATE SET
      last_beat_at = excluded.last_beat_at,
      build_version = excluded.build_version,
      git_sha = excluded.git_sha
  `)
}

function startHeartbeat() {
  // Independent timer so a slow poll doesn't starve the heartbeat.
  const tick = async () => {
    if (shuttingDown) return
    try { await beat() } catch (err) {
      log('heartbeat-failed', { err: err instanceof Error ? err.message : String(err) })
    }
    setTimeout(tick, HEARTBEAT_INTERVAL_MS).unref()
  }
  setTimeout(tick, 0).unref()
}

async function workLoop(sub: NotifySubscriber) {
  while (!shuttingDown) {
    try {
      const didPoll = await pollOneDueFeed(log)
      const didDispatch = await dispatchOnePending(log)
      if (!didPoll && !didDispatch) {
        // Sleep up to IDLE_SLEEP_MS — but wake immediately if a NOTIFY
        // arrives (UI added a feed, hit Retry, etc.). Sub-second
        // propagation without burning CPU on a tight poll loop.
        await sleepUntilKickOrMs(sub, IDLE_SLEEP_MS)
      }
    } catch (err) {
      log('work-loop-error', {
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      })
      await new Promise((r) => setTimeout(r, ERROR_SLEEP_MS))
    }
  }
}

async function main() {
  log('boot', { version: BUILD_VERSION, sha: GIT_SHA, role: env.SRN_ROLE })

  await runMigrations()
  log('migrations-applied')

  await bootstrap(log)

  const sub = await startNotifySubscriber(log)

  startHeartbeat()
  await workLoop(sub)
}

main().catch((err) => {
  log('fatal', { err: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
