import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { withAuth } from '@/lib/auth/withAuth'
import { withUser } from '@/lib/db/withUser'
import { writeAudit } from '@/lib/audit'
import { notifyFeedsChanged } from '@/lib/db/notify'

export const dynamic = 'force-dynamic'

const SINK_TYPES = ['smtp', 'resend', 'ntfy', 'discord_webhook'] as const
const EMAIL_SINK_TYPES: ReadonlyArray<typeof SINK_TYPES[number]> = ['smtp', 'resend']

const AddBody = z.object({
  sink_type: z.enum(SINK_TYPES),
  sink_id: z.string().uuid(),
  destination: z.string().max(320).optional().nullable(),
  enabled: z.boolean().default(true),
}).refine(
  (d) => !EMAIL_SINK_TYPES.includes(d.sink_type) || (typeof d.destination === 'string' && /.+@.+/.test(d.destination)),
  { message: 'destination email required for SMTP and Resend sinks', path: ['destination'] },
)

/** Add a new destination to an existing route. */
export const POST = withAuth(async (req, { session, ip }, route) => {
  const { id } = await route.params
  const json = await req.json().catch(() => null)
  const parsed = AddBody.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
  }

  return withUser(session.uid, async (tx) => {
    const routeExists = await tx.execute(sql`SELECT 1 FROM routes WHERE id = ${id}::uuid`)
    if (routeExists.length === 0) return NextResponse.json({ error: 'route-not-found' }, { status: 404 })

    const sinkTable = parsed.data.sink_type === 'smtp' ? sql`sinks_smtp`
                    : parsed.data.sink_type === 'resend' ? sql`sinks_resend`
                    : parsed.data.sink_type === 'ntfy' ? sql`sinks_ntfy`
                    : sql`sinks_discord_webhook`
    const sinkExists = await tx.execute(sql`SELECT 1 FROM ${sinkTable} WHERE id = ${parsed.data.sink_id}::uuid`)
    if (sinkExists.length === 0) return NextResponse.json({ error: 'sink-not-found' }, { status: 400 })

    const dest = EMAIL_SINK_TYPES.includes(parsed.data.sink_type) ? (parsed.data.destination ?? null) : null

    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO route_destinations (route_id, sink_type, sink_id, destination, enabled)
      VALUES (${id}::uuid, ${parsed.data.sink_type}, ${parsed.data.sink_id}::uuid, ${dest}, ${parsed.data.enabled})
      RETURNING id
    `)
    const destId = rows[0]!.id

    void writeAudit({
      actor_user_id: session.uid, action: 'route.destination.add', target_type: 'route_destination',
      target_id: destId, after: { route_id: id, ...parsed.data }, via: 'web', ip,
    })
    void notifyFeedsChanged()
    return NextResponse.json({ ok: true, id: destId })
  })
})
