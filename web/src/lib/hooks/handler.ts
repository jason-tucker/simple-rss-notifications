import { looksLikeToken } from './token'
import { MAX_BODY_BYTES, normalizeHook, readBodyLimited, type NormalizedHook } from './normalize'
import { lookupBudget, trustedLimiter, untrustedLimiter } from './rateLimit'
import type { WebhookFeed } from './ingest'

/**
 * Request handling for the PUBLIC ingest endpoint (/api/hooks/<token>).
 * Kept out of the route file (and free of DB imports) so it can be unit
 * tested with injected lookup/ingest functions.
 *
 * The only credential is the unguessable token in the path, so:
 *   - the token is never logged, echoed, used as a limiter key, or put in an
 *     error body
 *   - the body is capped at 64 KB before it is parsed
 *
 * Throttling (in-memory, per process: see rateLimit.ts for why this
 * deliberately deviates from CLAUDE.md rule 11):
 *   1. per-IP "bad token" bucket: a slot is RESERVED (hit) before any token
 *      work, so an IP that has burned its budget never reaches looksLikeToken
 *      or the DB lookup, even with many requests in flight at once. The slot
 *      is refunded when the token resolves to an enabled feed, so only
 *      malformed/unknown/disabled tokens count against it.
 *   2. process-wide lookup budget (same reserve/refund): caps DB lookups for
 *      unknown tokens across all IPs. When exhausted, every lookup (valid
 *      tokens too) gets 429 until the window rolls over.
 *   3. per-feed bucket keyed feed:<id>, created only after the feed is found
 *   4. per-user bucket keyed user:<id>, shared by all of a user's hooks
 */

export const PER_IP_BAD = { limit: 30, windowMs: 60_000 }
export const LOOKUP_BUDGET = { limit: 600, windowMs: 60_000 }
const LOOKUP_BUDGET_KEY = 'lookups'
export const PER_FEED = { limit: 60, windowMs: 60_000 }
export const PER_USER = { limit: 120, windowMs: 60_000 }

export interface HookDeps {
  findFeed: (token: string) => Promise<WebhookFeed | null>
  ingest: (feed: WebhookFeed, n: NormalizedHook) => Promise<{ id: string; receivedAt: Date }>
  now?: () => number
}

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers })
}

function limited(retryAfterSec: number): Response {
  return json({ error: 'rate-limited' }, 429, { 'Retry-After': String(retryAfterSec) })
}

export async function handleHook(req: Request, token: string, ip: string, deps: HookDeps): Promise<Response> {
  const now = deps.now ?? Date.now
  const badKey = `bad:${ip}`

  // Reserve a bad-token slot BEFORE any token work (synchronously, so N
  // concurrent requests cannot all pass a peek and then all reach the DB).
  // Refunded below only if the token turns out to be valid.
  const pre = untrustedLimiter.hit(badKey, PER_IP_BAD.limit, PER_IP_BAD.windowMs, now())
  if (!pre.ok) return limited(pre.retryAfterSec)

  // Malformed: the reserved slot stays counted.
  if (!looksLikeToken(token)) return json({ error: 'not-found' }, 404)

  // Process-wide cap on lookups that miss (bounds DB work from many IPs).
  const budget = lookupBudget.hit(LOOKUP_BUDGET_KEY, LOOKUP_BUDGET.limit, LOOKUP_BUDGET.windowMs, now())
  if (!budget.ok) {
    untrustedLimiter.refund(badKey, PER_IP_BAD.windowMs, now())
    return limited(budget.retryAfterSec)
  }

  const feed = await deps.findFeed(token)
  // Unknown / disabled: both reserved slots stay counted.
  if (!feed || !feed.enabled) return json({ error: 'not-found' }, 404)

  untrustedLimiter.refund(badKey, PER_IP_BAD.windowMs, now())
  lookupBudget.refund(LOOKUP_BUDGET_KEY, LOOKUP_BUDGET.windowMs, now())

  const perFeed = trustedLimiter.hit(`feed:${feed.id}`, PER_FEED.limit, PER_FEED.windowMs, now())
  if (!perFeed.ok) return limited(perFeed.retryAfterSec)
  const perUser = trustedLimiter.hit(`user:${feed.user_id}`, PER_USER.limit, PER_USER.windowMs, now())
  if (!perUser.ok) return limited(perUser.retryAfterSec)

  const body = await readBodyLimited(req, MAX_BODY_BYTES)
  if (!body.ok) return json({ error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, 413)

  const url = new URL(req.url)
  let n: NormalizedHook
  try {
    n = normalizeHook({
      body: body.text,
      contentType: req.headers.get('content-type'),
      headers: req.headers,
      query: url.searchParams,
      feedName: feed.label,
    })
  } catch (err) {
    console.error('[hooks] normalize failed', { feed_id: feed.id, err: err instanceof Error ? err.message : String(err) })
    return json({ error: 'bad-payload' }, 400)
  }
  if (n.empty) return json({ error: 'empty-payload' }, 400)

  let saved
  try {
    saved = await deps.ingest(feed, n)
  } catch (err) {
    // Never include the URL/token; log only the error message.
    console.error('[hooks] ingest failed', { feed_id: feed.id, err: err instanceof Error ? err.message : String(err) })
    return json({ error: 'internal-error' }, 500)
  }

  if (url.searchParams.get('wait') === 'true') {
    return json(
      {
        id: saved.id,
        feed_id: feed.id,
        title: n.title,
        content: n.body,
        url: n.url,
        priority: n.priority,
        color: n.color,
        source: n.source,
        timestamp: saved.receivedAt.toISOString(),
      },
      200,
    )
  }
  return new Response(null, { status: 204 })
}
