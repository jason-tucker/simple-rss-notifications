import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { readSessionCookie } from '@/lib/auth/session'
import { isSameOrigin } from '@/lib/auth/csrf'
import { withUser } from '@/lib/db/withUser'
import { writeAudit } from '@/lib/audit'
import { clientIp } from '@/lib/ratelimit'
import { notifyFeedsChanged } from '@/lib/db/notify'

export const dynamic = 'force-dynamic'

const Patch = z.object({
  label: z.string().max(100).nullable().optional(),
  enabled: z.boolean().optional(),
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

  return withUser(session.uid, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      UPDATE routes SET
        label   = ${parsed.data.label === undefined ? sql`label` : sql`${parsed.data.label}`},
        enabled = COALESCE(${parsed.data.enabled ?? null}, enabled),
        updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING id
    `)
    if (!rows[0]) return NextResponse.json({ error: 'not-found' }, { status: 404 })
    void writeAudit({
      actor_user_id: session.uid, action: 'route.update', target_type: 'route',
      target_id: id, after: parsed.data, via: 'web', ip,
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
    // Cascades to route_destinations and (via that) to dispatches.
    const rows = await tx.execute<{ id: string }>(sql`DELETE FROM routes WHERE id = ${id}::uuid RETURNING id`)
    if (!rows[0]) return NextResponse.json({ error: 'not-found' }, { status: 404 })
    void writeAudit({
      actor_user_id: session.uid, action: 'route.delete', target_type: 'route',
      target_id: id, via: 'web', ip,
    })
    void notifyFeedsChanged()
    return NextResponse.json({ ok: true })
  })
}
