import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { withAuth } from '@/lib/auth/withAuth'
import { withUser } from '@/lib/db/withUser'
import { writeAudit } from '@/lib/audit'
import { notifyFeedsChanged } from '@/lib/db/notify'

export const dynamic = 'force-dynamic'

const Patch = z.object({
  destination: z.string().max(320).nullable().optional(),
  enabled: z.boolean().optional(),
})

export const PATCH = withAuth(async (req, { session, ip }, route) => {
  const { id, destId } = await route.params
  const json = await req.json().catch(() => null)
  const parsed = Patch.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
  }

  return withUser(session.uid, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      UPDATE route_destinations SET
        destination = ${parsed.data.destination === undefined ? sql`destination` : sql`${parsed.data.destination}`},
        enabled     = COALESCE(${parsed.data.enabled ?? null}, enabled),
        updated_at  = now()
      WHERE id = ${destId}::uuid AND route_id = ${id}::uuid
      RETURNING id
    `)
    if (!rows[0]) return NextResponse.json({ error: 'not-found' }, { status: 404 })
    void writeAudit({
      actor_user_id: session.uid, action: 'route.destination.update', target_type: 'route_destination',
      target_id: destId, after: { route_id: id, ...parsed.data }, via: 'web', ip,
    })
    void notifyFeedsChanged()
    return NextResponse.json({ ok: true })
  })
})

export const DELETE = withAuth(async (_req, { session, ip }, route) => {
  const { id, destId } = await route.params

  return withUser(session.uid, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      DELETE FROM route_destinations
      WHERE id = ${destId}::uuid AND route_id = ${id}::uuid
      RETURNING id
    `)
    if (!rows[0]) return NextResponse.json({ error: 'not-found' }, { status: 404 })
    void writeAudit({
      actor_user_id: session.uid, action: 'route.destination.delete', target_type: 'route_destination',
      target_id: destId, after: { route_id: id }, via: 'web', ip,
    })
    void notifyFeedsChanged()
    return NextResponse.json({ ok: true })
  })
})
