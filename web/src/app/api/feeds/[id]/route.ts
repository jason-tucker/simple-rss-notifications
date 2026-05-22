import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { readSessionCookie } from '@/lib/auth/session'
import { isSameOrigin } from '@/lib/auth/csrf'
import { withUser } from '@/lib/db/withUser'
import { writeAudit } from '@/lib/audit'
import { clientIp } from '@/lib/ratelimit'
import { checkSafeOutboundUrl } from '@/lib/ssrf'
import { notifyFeedsChanged } from '@/lib/db/notify'

export const dynamic = 'force-dynamic'

const POLL_MIN = 60
const POLL_MAX = 24 * 60 * 60

const Patch = z.object({
  label: z.string().min(1).max(100).optional(),
  url: z.string().url().max(2048).optional(),
  enabled: z.boolean().optional(),
  poll_interval_s: z.number().int().min(POLL_MIN).max(POLL_MAX).optional(),
})

type Params = { id: string }

export async function PATCH(req: NextRequest, ctx: { params: Promise<Params> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const json = await req.json().catch(() => null)
  const parsed = Patch.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
  }
  const ip = clientIp(req)

  if (parsed.data.url) {
    const ssrf = await checkSafeOutboundUrl(parsed.data.url)
    if (ssrf) return NextResponse.json({ error: ssrf, code: 'ssrf-blocked' }, { status: 400 })
  }

  return withUser(session.uid, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      UPDATE feeds SET
        label           = COALESCE(${parsed.data.label ?? null},            label),
        url             = COALESCE(${parsed.data.url ?? null},              url),
        enabled         = COALESCE(${parsed.data.enabled ?? null},          enabled),
        poll_interval_s = COALESCE(${parsed.data.poll_interval_s ?? null},  poll_interval_s),
        -- Resetting URL clears the HTTP cache hints so the next poll starts fresh.
        etag          = CASE WHEN ${parsed.data.url ?? null}::text IS NOT NULL THEN NULL ELSE etag END,
        last_modified = CASE WHEN ${parsed.data.url ?? null}::text IS NOT NULL THEN NULL ELSE last_modified END,
        updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING id
    `)
    if (!rows[0]) return NextResponse.json({ error: 'not-found' }, { status: 404 })
    void writeAudit({
      actor_user_id: session.uid,
      action: 'feed.update',
      target_type: 'feed',
      target_id: id,
      after: parsed.data,
      via: 'web',
      ip,
    })
    void notifyFeedsChanged()
    return NextResponse.json({ ok: true })
  })
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<Params> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const ip = clientIp(req)

  return withUser(session.uid, async (tx) => {
    // Cascades to feed_items, routes (which cascade to dispatches).
    const rows = await tx.execute<{ id: string }>(sql`DELETE FROM feeds WHERE id = ${id}::uuid RETURNING id`)
    if (!rows[0]) return NextResponse.json({ error: 'not-found' }, { status: 404 })
    void writeAudit({
      actor_user_id: session.uid,
      action: 'feed.delete',
      target_type: 'feed',
      target_id: id,
      via: 'web',
      ip,
    })
    void notifyFeedsChanged()
    return NextResponse.json({ ok: true })
  })
}
