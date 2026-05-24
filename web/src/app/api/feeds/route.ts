import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { readSessionCookie } from '@/lib/auth/session'
import { isSameOrigin } from '@/lib/auth/csrf'
import { withUser } from '@/lib/db/withUser'
import { encrypt } from '@/lib/crypto/aead'
import { writeAudit, redactSecretFields } from '@/lib/audit'
import { clientIp } from '@/lib/ratelimit'
import { checkSafeOutboundUrl } from '@/lib/ssrf'
import { notifyFeedsChanged } from '@/lib/db/notify'

export const dynamic = 'force-dynamic'

const POLL_MIN = 60
const POLL_MAX = 24 * 60 * 60

const Body = z.object({
  label: z.string().min(1).max(100),
  url: z.string().url().max(2048),
  poll_interval_s: z.number().int().min(POLL_MIN).max(POLL_MAX).default(900),
  enabled: z.boolean().default(true),
  backfill_mode: z.enum(['none', 'count', 'days']).default('none'),
  backfill_value: z.number().int().min(0).max(10_000).default(0),
  backfill_pace_seconds: z.number().int().min(0).max(24 * 60 * 60).default(0),
  // Optional `Cookie:` header value, sent on every poll. Encrypted at rest.
  // 8 KB matches typical browser cookie-jar limits and is plenty for the
  // multi-cookie strings XenForo / Cloudflare auth produces.
  cookie: z.string().max(8192).optional(),
})

export async function GET() {
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  return withUser(session.uid, async (tx) => {
    const rows = await tx.execute<{
      id: string; label: string; url: string; enabled: boolean
      poll_interval_s: number
      last_polled_at: Date | null; last_success_at: Date | null
      last_error: string | null; last_error_at: Date | null
      consecutive_failures: number
      backfill_mode: string; backfill_value: number; backfill_pace_seconds: number
      has_cookie: boolean
      created_at: Date
    }>(sql`
      SELECT id, label, url, enabled, poll_interval_s,
             last_polled_at, last_success_at, last_error, last_error_at,
             consecutive_failures, backfill_mode, backfill_value, backfill_pace_seconds,
             (cookie_ciphertext IS NOT NULL) AS has_cookie,
             created_at
      FROM feeds ORDER BY created_at
    `)
    return NextResponse.json({ feeds: rows })
  })
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const json = await req.json().catch(() => null)
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
  }

  // Storing a cookie counts as "writing a stored secret" per CLAUDE.md
  // §Auth — require a fresh re-auth (elevated session). Cookie-free creates
  // stay unrestricted so casual feed adds don't need elevation.
  if (typeof parsed.data.cookie === 'string' && parsed.data.cookie.length > 0) {
    const now = Math.floor(Date.now() / 1000)
    if (!session.elevatedUntil || session.elevatedUntil < now) {
      return NextResponse.json(
        { error: 'reauth-required', code: 'reauth-required' },
        { status: 403 },
      )
    }
  }

  // SSRF guard at create time. Re-checked on every poll too, but reject
  // obviously-bad URLs up front so the user sees the error immediately.
  const ssrf = await checkSafeOutboundUrl(parsed.data.url)
  if (ssrf) {
    return NextResponse.json({ error: ssrf, code: 'ssrf-blocked' }, { status: 400 })
  }

  const ip = clientIp(req)
  return withUser(session.uid, async (tx) => {
    const enc = parsed.data.cookie && parsed.data.cookie.length > 0 ? encrypt(parsed.data.cookie) : null
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO feeds (
        user_id, label, url, enabled, poll_interval_s,
        backfill_mode, backfill_value, backfill_pace_seconds,
        cookie_ciphertext, cookie_iv, cookie_tag, cookie_key_version
      ) VALUES (
        ${session.uid}::uuid, ${parsed.data.label}, ${parsed.data.url},
        ${parsed.data.enabled}, ${parsed.data.poll_interval_s},
        ${parsed.data.backfill_mode}, ${parsed.data.backfill_value}, ${parsed.data.backfill_pace_seconds},
        ${enc?.ciphertext ?? null}, ${enc?.iv ?? null}, ${enc?.tag ?? null}, ${enc?.keyVersion ?? null}
      )
      RETURNING id
    `)
    const id = rows[0]!.id
    void writeAudit({
      actor_user_id: session.uid,
      action: 'feed.create',
      target_type: 'feed',
      target_id: id,
      after: redactSecretFields(parsed.data, ['cookie']),
      via: 'web',
      ip,
    })
    void notifyFeedsChanged()
    return NextResponse.json({ ok: true, id })
  })
}
