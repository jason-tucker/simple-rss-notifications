import 'server-only'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { readSessionCookie, type Session } from './session'
import { isSameOrigin } from './csrf'
import { rateLimit, clientIp } from '@/lib/ratelimit'

/**
 * Standard wrapper for authenticated API routes.
 *
 *   export const POST = withAuth(async (req, ctx) => { ... }, {
 *     requireElevated: false,    // gate sensitive ops (PR4 sets to true)
 *     rateLimitPerUser: { limit: 120, windowMs: 60_000 },
 *   })
 *
 * Does, in order:
 *   1. Verify the session JWT cookie and decode it.
 *   2. Look up the server-side jti in web_sessions; reject if revoked or expired.
 *   3. Check the user row's password_changed_at > JWT.iat; reject if so
 *      (a password change since this JWT was issued invalidates it).
 *   4. Enforce CSRF origin check for non-GET methods.
 *   5. Apply per-user rate limit (default 120/min) and per-IP ceiling.
 *   6. If requireElevated, verify session.elevatedUntil > now (PR4 feature
 *      — until then no route sets requireElevated=true).
 *   7. Call the handler with `(req, { session, ip })`.
 *
 * All rejection paths return JSON with a stable `code` so the UI can react.
 */

export interface AuthContext {
  session: Session
  ip: string
}

export interface WithAuthOptions {
  requireElevated?: boolean
  rateLimitPerUser?: { limit: number; windowMs: number }
  rateLimitPerIp?: { limit: number; windowMs: number }
}

type Handler = (req: NextRequest, ctx: AuthContext) => Promise<Response> | Response

const DEFAULT_USER_LIMIT = { limit: 120, windowMs: 60_000 }
const DEFAULT_IP_LIMIT = { limit: 600, windowMs: 60_000 }

export function withAuth(handler: Handler, opts: WithAuthOptions = {}): Handler {
  return async (req, _ctx) => {
    const ip = clientIp(req)

    // 1+2+3: session presence + DB mirror + password-change invalidation
    const session = await readSessionCookie()
    if (!session) {
      return NextResponse.json({ error: 'unauthorized', code: 'no-session' }, { status: 401 })
    }

    const userRows = await db.execute<{ password_changed_at: Date; username: string }>(sql`
      SELECT password_changed_at, username FROM users WHERE id = ${session.uid}::uuid LIMIT 1
    `)
    const userRow = userRows[0]
    if (!userRow) {
      return NextResponse.json({ error: 'unauthorized', code: 'user-missing' }, { status: 401 })
    }
    if (Math.floor(new Date(userRow.password_changed_at).getTime() / 1000) > session.iat) {
      return NextResponse.json({ error: 'unauthorized', code: 'password-changed' }, { status: 401 })
    }

    const sessRows = await db.execute<{ revoked_at: Date | null; expires_at: Date }>(sql`
      SELECT revoked_at, expires_at FROM web_sessions WHERE jti = ${session.jti} LIMIT 1
    `)
    const sessRow = sessRows[0]
    if (!sessRow) {
      return NextResponse.json({ error: 'unauthorized', code: 'session-revoked' }, { status: 401 })
    }
    if (sessRow.revoked_at || new Date(sessRow.expires_at).getTime() < Date.now()) {
      return NextResponse.json({ error: 'unauthorized', code: 'session-revoked' }, { status: 401 })
    }

    // 4: CSRF (non-GET only)
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOrigin(req)) {
      return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
    }

    // 5: rate limits — per user and per IP
    const userLimit = opts.rateLimitPerUser ?? DEFAULT_USER_LIMIT
    const ipLimit = opts.rateLimitPerIp ?? DEFAULT_IP_LIMIT
    const [perUser, perIp] = await Promise.all([
      rateLimit(`api:user:${session.uid}`, userLimit),
      rateLimit(`api:ip:${ip}`, ipLimit),
    ])
    if (!perUser.ok || !perIp.ok) {
      const r = !perUser.ok ? perUser : perIp
      return NextResponse.json(
        { error: 'rate-limited', code: 'rate-limited', retryAfterSec: r.retryAfterSec },
        { status: 429, headers: { 'Retry-After': String(r.retryAfterSec) } },
      )
    }

    // 6: elevation gate
    if (opts.requireElevated) {
      const now = Math.floor(Date.now() / 1000)
      if (!session.elevatedUntil || session.elevatedUntil < now) {
        return NextResponse.json({ error: 'reauth-required', code: 'reauth-required' }, { status: 403 })
      }
    }

    // Last-seen bookkeeping — best-effort, never blocks the handler.
    void db.execute(sql`UPDATE web_sessions SET last_seen_at = now() WHERE jti = ${session.jti}`).catch(() => {})

    return handler(req, { session, ip })
  }
}
