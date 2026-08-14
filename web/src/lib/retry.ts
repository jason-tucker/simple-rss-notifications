/**
 * Retry-policy helpers for the dispatcher. Pure functions, unit-tested.
 *
 * Split out of dispatcher.ts so the backoff math and Retry-After parsing
 * can be tested without a database.
 */

/** Max seconds we'll ever wait between attempts, server hint or not. */
export const MAX_RETRY_DELAY_SEC = 3600

/**
 * Exponential backoff for the Nth attempt (1-based):
 * 60s, 5m, 25m, then capped at 1h.
 */
export function backoffSec(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_SEC, 60 * Math.pow(5, Math.max(0, attempts - 1)))
}

/**
 * Parse a Retry-After header value — either delta-seconds ("120") or an
 * HTTP-date — into whole seconds from now. Returns null when absent or
 * unparseable. Negative results clamp to 0 (the date already passed).
 */
export function parseRetryAfterSec(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  // HTTP-dates always contain letters ("Wed, 21 Oct 2026 07:28:00 GMT").
  // Guard before Date.parse — V8 leniently parses digit strings like
  // "12.5.3" as real dates, which would turn garbage into a hint.
  if (!/[A-Za-z]/.test(trimmed)) return null
  const dateMs = Date.parse(trimmed)
  if (Number.isNaN(dateMs)) return null
  return Math.max(0, Math.ceil((dateMs - nowMs) / 1000))
}

/**
 * Delay before the next attempt: our own backoff, stretched (never
 * shortened below 1s) by the server's rate-limit hint when present, and
 * always capped so a hostile/buggy header can't park a dispatch for hours.
 */
export function retryDelaySec(attempts: number, retryAfterSec?: number | null): number {
  const base = backoffSec(attempts)
  if (retryAfterSec == null || retryAfterSec <= 0) return base
  return Math.min(MAX_RETRY_DELAY_SEC, Math.max(base, Math.ceil(retryAfterSec)))
}

/**
 * Rate-limit hint from a 429 response's headers: standard Retry-After
 * plus Discord's X-RateLimit-Reset-After (float seconds) — the larger
 * wins. One shared extraction path for every provider so a future sink
 * gets it for free. Returns undefined for non-429 responses or when no
 * usable hint is present.
 */
export function retryAfterHintSec(
  headers: { get(name: string): string | null },
  status: number,
  nowMs: number = Date.now(),
): number | undefined {
  if (status !== 429) return undefined
  const ra = parseRetryAfterSec(headers.get('retry-after'), nowMs)
  const reset = Number(headers.get('x-ratelimit-reset-after'))
  const resetSec = Number.isFinite(reset) && reset > 0 ? Math.ceil(reset) : 0
  const max = Math.max(ra ?? 0, resetSec)
  return max > 0 ? max : undefined
}

/**
 * Failure codes that will not fix themselves on retry:
 *   sink-incomplete       user hasn't filled the password/key
 *   decrypt-failed        key mismatch — wait for human
 *   ssrf-blocked          sink points at a private address
 *   EAUTH / EENVELOPE     SMTP wrong creds / bad from-to
 *   *-http-4xx            provider rejected the request itself
 *                         (generic suffix rule so future sink types are
 *                         covered without editing this list)
 *
 * EXCEPT HTTP 429 — "too many requests" is transient by definition, and
 * must retry (with the provider's Retry-After hint) or notifications are
 * silently lost whenever a provider briefly rate-limits us.
 * Everything else (timeouts, 5xx, network) is transient.
 */
export function isPermanentFailure(code?: string): boolean {
  if (!code) return false
  if (code.endsWith('-http-429')) return false
  if (code === 'sink-incomplete') return true
  if (code === 'decrypt-failed') return true
  if (code === 'ssrf-blocked') return true
  if (code === 'EAUTH' || code === 'EENVELOPE') return true
  if (/-http-4\d\d$/.test(code)) return true
  return false
}
