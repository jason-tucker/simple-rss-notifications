import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { readSessionCookie } from '@/lib/auth/session'
import { isSameOrigin } from '@/lib/auth/csrf'
import { withUser } from '@/lib/db/withUser'
import { writeAudit } from '@/lib/audit'
import { clientIp, rateLimit } from '@/lib/ratelimit'

export const dynamic = 'force-dynamic'

type Params = { id: string }

/**
 * Reset a failed dispatch back to 'pending' so the worker picks it up
 * on its next tick. Only allowed for `status='failed'` rows — retrying a
 * 'sent' row would re-send the email, retrying a 'pending' row is a no-op.
 *
 * Rate-limited per user to keep someone from hammering the worker via
 * repeated retries on bulk-failed dispatches.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<Params> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const ip = clientIp(req)

  const rl = await rateLimit(`retry:user:${session.uid}`, { limit: 30, windowMs: 60_000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate-limited', code: 'rate-limited', retryAfterSec: rl.retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  return withUser(session.uid, async (tx) => {
    // Only flip 'failed' rows; anything else is a 409. Attempts counter
    // is reset to 0 so the exponential backoff ladder starts fresh.
    const rows = await tx.execute<{ id: string; previous_status: string }>(sql`
      UPDATE dispatches
      SET status = 'pending',
          scheduled_at = now(),
          attempts = 0,
          error = NULL,
          dispatched_at = NULL
      WHERE id = ${id}::uuid AND status = 'failed'
      RETURNING id, 'failed' AS previous_status
    `)
    if (!rows[0]) {
      // Either not found OR not in 'failed' state.
      const status = await tx.execute<{ status: string }>(sql`SELECT status FROM dispatches WHERE id = ${id}::uuid`)
      if (status.length === 0) return NextResponse.json({ error: 'not-found' }, { status: 404 })
      return NextResponse.json({ error: 'not-retryable', code: 'not-retryable', currentStatus: status[0]!.status }, { status: 409 })
    }
    void writeAudit({
      actor_user_id: session.uid,
      action: 'dispatch.retry',
      target_type: 'dispatch',
      target_id: id,
      via: 'web',
      ip,
    })
    return NextResponse.json({ ok: true })
  })
}
