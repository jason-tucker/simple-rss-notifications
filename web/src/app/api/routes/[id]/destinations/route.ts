import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { readSessionCookie } from '@/lib/auth/session'
import { isSameOrigin } from '@/lib/auth/csrf'
import { withUser } from '@/lib/db/withUser'
import { writeAudit } from '@/lib/audit'
import { clientIp } from '@/lib/ratelimit'

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

type Params = { id: string }

/** Add a new destination to an existing route. */
export async function POST(req: NextRequest, ctx: { params: Promise<Params> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const json = await req.json().catch(() => null)
  const parsed = AddBody.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
  }
  const ip = clientIp(req)

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
    return NextResponse.json({ ok: true, id: destId })
  })
}
