/**
 * Worker entrypoint. Same image as the web container; the `SRN_ROLE=worker`
 * env var and the compose `command:` override route us here instead of the
 * Next.js HTTP server.
 *
 * v0.1.0: heartbeat loop only. Real responsibilities land PR-by-PR:
 *   PR6 — Postgres LISTEN/NOTIFY + 60s safety-net poll + heartbeat to DB
 *   PR7 — RSS poller (per-feed cadence, ETag/304, dedup, retry-on-boot)
 *   PR10 — ntfy SSE subscriber (long-lived per topic, exp backoff reconnect)
 */

import { env } from '@/lib/env'
import { BUILD_VERSION, GIT_SHA } from '@/lib/version'

const HEARTBEAT_INTERVAL_MS = 30_000

let shuttingDown = false

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), role: 'worker', msg, ...extra }))
}

process.on('SIGTERM', () => { shuttingDown = true; log('shutdown', { signal: 'SIGTERM' }); process.exit(0) })
process.on('SIGINT',  () => { shuttingDown = true; log('shutdown', { signal: 'SIGINT'  }); process.exit(0) })
process.on('unhandledRejection', (reason) => { log('unhandled-rejection', { reason: String(reason) }); process.exit(1) })
process.on('uncaughtException',  (err)    => { log('uncaught-exception',  { err: err.message })       ; process.exit(1) })

async function main() {
  log('boot', { version: BUILD_VERSION, sha: GIT_SHA, role: env.SRN_ROLE })

  // Heartbeat loop. PR6 replaces the console log with a DB write into
  // `worker_heartbeats(last_beat_at)` so `/api/health/worker` can flag stale.
  while (!shuttingDown) {
    log('heartbeat', { uptimeSec: Math.floor(process.uptime()) })
    await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL_MS))
  }
}

main().catch((err) => {
  log('fatal', { err: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
