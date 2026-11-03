import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { withAuth } from '@/lib/auth/withAuth'
import { withUser } from '@/lib/db/withUser'
import { writeAudit } from '@/lib/audit'
import { generateToken, hashToken, hookUrl } from '@/lib/hooks/token'
import { UUID_RE } from '@/lib/items'

export const dynamic = 'force-dynamic'

/**
 * POST /api/feeds/:id/regenerate-token — webhook feeds only. Replaces the
 * stored hash (the old URL stops working immediately) and returns the new
 * URL once.
 */
export const POST = withAuth(async (_req, { session, ip }, route) => {
  const { id } = await route.params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not-found' }, { status: 404 })

  const token = generateToken()
  return withUser(session.uid, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      UPDATE feeds SET token_hash = ${hashToken(token)}, updated_at = now()
      WHERE id = ${id}::uuid AND kind = 'webhook'
      RETURNING id
    `)
    if (!rows[0]) return NextResponse.json({ error: 'not-found' }, { status: 404 })
    void writeAudit({
      actor_user_id: session.uid,
      action: 'feed.regenerate_token',
      target_type: 'feed',
      target_id: id,
      after: { token: '[REDACTED]' },
      via: 'web',
      ip,
    })
    return NextResponse.json({ ok: true, hook_url: hookUrl(token) }, { headers: { 'Cache-Control': 'no-store' } })
  })
})
