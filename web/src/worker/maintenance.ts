import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'

type Logger = (msg: string, extra?: Record<string, unknown>) => void

export const MAINTENANCE_INTERVAL_MS = 60 * 60_000

/**
 * Hourly hygiene sweep. Deletes ONLY rows that are dead by definition:
 *
 *   - web_sessions past expires_at — withAuth/readSessionCookie already
 *     reject them; without this sweep they accumulate forever (only
 *     logout/password-change ever delete rows today).
 *   - rate_limit_buckets whose window started > 1 day ago — the longest
 *     limiter window in use is 1 hour (login/change-password per-IP), so
 *     a full day of grace is ultra-conservative. Without this the table
 *     grows unbounded (one row per user/IP/bucket key, forever).
 *
 * Runs on the worker's owner connection (cross-user maintenance is the
 * point). Never throws — a failed sweep logs and retries next interval.
 */
export async function runMaintenance(log: Logger): Promise<void> {
  try {
    const sessions = await db.execute(sql`
      DELETE FROM web_sessions WHERE expires_at < now()
    `)
    const buckets = await db.execute(sql`
      DELETE FROM rate_limit_buckets WHERE window_start < now() - interval '1 day'
    `)
    log('maintenance-cleanup', {
      sessions_deleted: countOf(sessions),
      buckets_deleted: countOf(buckets),
    })
  } catch (err) {
    log('maintenance-failed', { err: err instanceof Error ? err.message : String(err) })
  }
}

/** postgres-js result lists carry the affected-row count on `.count`. */
function countOf(res: unknown): number {
  const c = (res as { count?: number } | null)?.count
  return typeof c === 'number' ? c : 0
}
