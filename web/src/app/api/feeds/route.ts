import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { withAuth } from '@/lib/auth/withAuth'
import { withUser } from '@/lib/db/withUser'
import { writeAudit } from '@/lib/audit'
import { checkSafeOutboundUrl } from '@/lib/ssrf'
import { notifyFeedsChanged } from '@/lib/db/notify'
import { generateToken, hashToken, hookUrl } from '@/lib/hooks/token'

export const dynamic = 'force-dynamic'

const POLL_MIN = 60
const POLL_MAX = 24 * 60 * 60

const Body = z
  .object({
    kind: z.enum(['rss', 'webhook']).default('rss'),
    label: z.string().min(1).max(100),
    url: z.string().url().max(2048).optional(),
    poll_interval_s: z.number().int().min(POLL_MIN).max(POLL_MAX).default(900),
    enabled: z.boolean().default(true),
    backfill_mode: z.enum(['none', 'count', 'days']).default('none'),
    backfill_value: z.number().int().min(0).max(10_000).default(0),
    backfill_pace_seconds: z.number().int().min(0).max(24 * 60 * 60).default(0),
  })
  .refine((b) => b.kind === 'webhook' || !!b.url, { message: 'url is required for rss feeds', path: ['url'] })

export const GET = withAuth(async (_req, { session }) => {
  return withUser(session.uid, async (tx) => {
    const rows = await tx.execute<{
      id: string; kind: string; label: string; url: string | null; enabled: boolean
      poll_interval_s: number
      last_polled_at: Date | null; last_success_at: Date | null
      last_error: string | null; last_error_at: Date | null
      consecutive_failures: number
      backfill_mode: string; backfill_value: number; backfill_pace_seconds: number
      created_at: Date
    }>(sql`
      SELECT id, kind, label, url, enabled, poll_interval_s,
             last_polled_at, last_success_at, last_error, last_error_at,
             consecutive_failures, backfill_mode, backfill_value, backfill_pace_seconds,
             created_at
      FROM feeds ORDER BY created_at
    `)
    return NextResponse.json({ feeds: rows })
  })
})

export const POST = withAuth(async (req, { session, ip }) => {
  const json = await req.json().catch(() => null)
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
  }

  if (parsed.data.kind === 'webhook') {
    // Only the sha256 of the token is stored; the plaintext URL is returned
    // exactly once, here.
    const token = generateToken()
    return withUser(session.uid, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO feeds (user_id, kind, label, url, token_hash, enabled, backfill_mode)
        VALUES (
          ${session.uid}::uuid, 'webhook', ${parsed.data.label}, NULL, ${hashToken(token)},
          ${parsed.data.enabled}, 'done'
        )
        RETURNING id
      `)
      const id = rows[0]!.id
      void writeAudit({
        actor_user_id: session.uid,
        action: 'feed.create',
        target_type: 'feed',
        target_id: id,
        after: { kind: 'webhook', label: parsed.data.label, enabled: parsed.data.enabled, token: '[REDACTED]' },
        via: 'web',
        ip,
      })
      void notifyFeedsChanged()
      return NextResponse.json(
        { ok: true, id, kind: 'webhook', hook_url: hookUrl(token) },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    })
  }

  // SSRF guard at create time. Re-checked on every poll too, but reject
  // obviously-bad URLs up front so the user sees the error immediately.
  const url = parsed.data.url!
  const ssrf = await checkSafeOutboundUrl(url)
  if (ssrf) {
    return NextResponse.json({ error: ssrf, code: 'ssrf-blocked' }, { status: 400 })
  }

  return withUser(session.uid, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO feeds (
        user_id, label, url, enabled, poll_interval_s,
        backfill_mode, backfill_value, backfill_pace_seconds
      ) VALUES (
        ${session.uid}::uuid, ${parsed.data.label}, ${url},
        ${parsed.data.enabled}, ${parsed.data.poll_interval_s},
        ${parsed.data.backfill_mode}, ${parsed.data.backfill_value}, ${parsed.data.backfill_pace_seconds}
      )
      RETURNING id
    `)
    const id = rows[0]!.id
    void writeAudit({
      actor_user_id: session.uid,
      action: 'feed.create',
      target_type: 'feed',
      target_id: id,
      after: parsed.data,
      via: 'web',
      ip,
    })
    void notifyFeedsChanged()
    return NextResponse.json({ ok: true, id })
  })
})
