import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'

/**
 * Sliding-window rate limiter backed by Postgres. One atomic upsert per
 * check — no Redis, no in-memory state, durable across web restarts.
 *
 *   const r = await rateLimit('login:ip:1.2.3.4', { limit: 5, windowMs: 60_000 })
 *   if (!r.ok) return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': String(r.retryAfterSec) } })
 *
 * Strategy: a single row per bucket. On hit:
 *   - If the row doesn't exist, insert with count=1, window_start=now.
 *   - If the existing window is stale (now - window_start > windowMs),
 *     reset to count=1, window_start=now.
 *   - Otherwise increment count.
 *   - Return ok=false (count > limit) with a Retry-After.
 *
 * One INSERT ... ON CONFLICT DO UPDATE does all of this atomically.
 */

export interface RateLimitOptions {
  /** Max hits per window. */
  limit: number
  /** Window size in milliseconds. */
  windowMs: number
}

export interface RateLimitResult {
  ok: boolean
  count: number
  limit: number
  retryAfterSec: number
  /** Total ms remaining until the current window closes. */
  windowRemainingMs: number
}

export async function rateLimit(key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
  const windowSec = Math.ceil(opts.windowMs / 1000)

  const rows = await db.execute<{
    new_count: number
    window_start: Date
  }>(sql`
    INSERT INTO rate_limit_buckets (key, count, window_start)
    VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN (extract(epoch from now() - rate_limit_buckets.window_start) * 1000) > ${opts.windowMs}::bigint
          THEN 1
        ELSE rate_limit_buckets.count + 1
      END,
      window_start = CASE
        WHEN (extract(epoch from now() - rate_limit_buckets.window_start) * 1000) > ${opts.windowMs}::bigint
          THEN now()
        ELSE rate_limit_buckets.window_start
      END
    RETURNING count AS new_count, window_start
  `)

  const row = rows[0]
  if (!row) {
    // Should be impossible — the upsert always returns a row. Fail closed.
    return { ok: false, count: opts.limit + 1, limit: opts.limit, retryAfterSec: windowSec, windowRemainingMs: opts.windowMs }
  }

  const count = Number(row.new_count)
  const windowStart = new Date(row.window_start).getTime()
  const elapsed = Date.now() - windowStart
  const remaining = Math.max(0, opts.windowMs - elapsed)
  const retryAfterSec = Math.max(1, Math.ceil(remaining / 1000))

  return {
    ok: count <= opts.limit,
    count,
    limit: opts.limit,
    retryAfterSec,
    windowRemainingMs: remaining,
  }
}

/**
 * Convenience for the common case: check all of several buckets, return
 * the FIRST one that's over its limit. Lets you express "5/min per IP AND
 * 10/hour per username" as two policies, with the stricter one tripping
 * the 429.
 */
export async function rateLimitAll(checks: Array<{ key: string; opts: RateLimitOptions }>): Promise<RateLimitResult> {
  const results = await Promise.all(checks.map((c) => rateLimit(c.key, c.opts)))
  const exceeded = results.find((r) => !r.ok)
  return exceeded ?? results[results.length - 1]!
}

/**
 * Extract a stable client IP from a Request. Cloudflared sets
 * `CF-Connecting-IP`; we trust it because the only network path to our
 * Caddy is the Cloudflare Tunnel. Falls back to `x-forwarded-for` (first
 * hop) and finally a literal "unknown" so the rate limit still applies
 * to anonymous abuse.
 */
export function clientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}
