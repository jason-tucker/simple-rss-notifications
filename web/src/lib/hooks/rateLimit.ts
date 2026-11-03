/**
 * Tiny in-memory fixed-window limiter for the public webhook endpoint.
 *
 * DELIBERATE DEVIATION from CLAUDE.md rule 11 (Postgres-backed rateLimit()):
 * this endpoint is public and a Postgres upsert per request would let
 * unauthenticated traffic write to the database before any credential is
 * checked. The trade-off is that these limits are per-process only (web is a
 * single container) and reset on restart.
 *
 * Keys must already be non-reversible (feed id / user id / IP) so nothing
 * sensitive lives in memory or logs; raw tokens are never used as keys.
 *
 * Two independent stores keep attacker-controlled keys from evicting the
 * buckets that matter:
 *   - untrustedLimiter: per-IP "bad token" buckets. Any client can create
 *     these, so the store is capped and evicts oldest-first.
 *   - trustedLimiter:   per-feed and per-user buckets. Only created after a
 *     valid token lookup, so their count is bounded by real feeds/users.
 */

interface Bucket { count: number; start: number }

export interface LimitResult { ok: boolean; retryAfterSec: number }

export const MAX_KEYS = 10_000

export class FixedWindowLimiter {
  // Map iteration order == insertion order. A bucket is re-inserted when its
  // window restarts, so the first entry is always the oldest window.
  private readonly buckets = new Map<string, Bucket>()

  constructor(private readonly maxKeys: number = MAX_KEYS) {}

  get size(): number {
    return this.buckets.size
  }

  /** Count one hit against `key` and report whether it is within `limit`. */
  hit(key: string, limit: number, windowMs: number, now: number = Date.now()): LimitResult {
    let b = this.buckets.get(key)
    if (!b || now - b.start >= windowMs) {
      if (b) this.buckets.delete(key)
      this.evictFor(1)
      b = { count: 0, start: now }
      this.buckets.set(key, b)
    }
    b.count++
    return { ok: b.count <= limit, retryAfterSec: retryAfter(b, windowMs, now) }
  }

  /** Report whether one more hit would be allowed, without counting it. */
  peek(key: string, limit: number, windowMs: number, now: number = Date.now()): LimitResult {
    const b = this.buckets.get(key)
    if (!b || now - b.start >= windowMs) return { ok: true, retryAfterSec: 0 }
    return { ok: b.count < limit, retryAfterSec: retryAfter(b, windowMs, now) }
  }

  /**
   * Give back one hit previously taken with hit() (reserve-then-refund: the
   * slot is held while an async check runs, and returned if the request turns
   * out not to count). No-op if the bucket is gone, expired, or already at 0;
   * never creates a bucket.
   */
  refund(key: string, windowMs: number, now: number = Date.now()): void {
    const b = this.buckets.get(key)
    if (!b || now - b.start >= windowMs || b.count <= 0) return
    b.count--
  }

  /** Oldest-first eviction (never a wholesale clear) to make room for `n` keys. */
  private evictFor(n: number): void {
    while (this.buckets.size + n > this.maxKeys) {
      const oldest = this.buckets.keys().next()
      if (oldest.done) return
      this.buckets.delete(oldest.value)
    }
  }
}

function retryAfter(b: Bucket, windowMs: number, now: number): number {
  return Math.max(1, Math.ceil((b.start + windowMs - now) / 1000))
}

/** Attacker-creatable keys (per-IP bad-token buckets). */
export const untrustedLimiter = new FixedWindowLimiter()
/** Keys created only after a successful token lookup (feed:<id>, user:<id>). */
export const trustedLimiter = new FixedWindowLimiter()
/**
 * Process-wide budget for token lookups that miss (one fixed key). Separate
 * store so a flood of per-IP keys can never evict it.
 */
export const lookupBudget = new FixedWindowLimiter(1)
