import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { withAuth } from '@/lib/auth/withAuth'
import { withUser } from '@/lib/db/withUser'
import { writeAudit } from '@/lib/audit'
import { notifyDispatchesChanged } from '@/lib/db/notify'

export const dynamic = 'force-dynamic'

/**
 * Reset a failed dispatch back to 'pending' so the worker picks it up
 * on its next tick. Only allowed for `status='failed'` rows — retrying a
 * 'sent' row would re-send the email, retrying a 'pending' row is a no-op.
 *
 * Rate-limited per user (30/min via withAuth) to keep someone from
 * hammering the worker via repeated retries on bulk-failed dispatches.
 */
export const POST = withAuth(
  async (_req, { session, ip }, route) => {
    const { id } = await route.params

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
      void notifyDispatchesChanged()
      return NextResponse.json({ ok: true })
    })
  },
  { rateLimitPerUser: { limit: 30, windowMs: 60_000 } },
)
