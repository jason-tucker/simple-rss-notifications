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

const SINK_TYPES = ['smtp', 'resend', 'ntfy', 'discord_webhook'] as const
const EMAIL_SINK_TYPES: ReadonlyArray<typeof SINK_TYPES[number]> = ['smtp', 'resend']

const DestinationInput = z.object({
  sink_type: z.enum(SINK_TYPES),
  sink_id: z.string().uuid(),
  destination: z.string().max(320).optional().nullable(),
  enabled: z.boolean().default(true),
}).refine(
  (d) => !EMAIL_SINK_TYPES.includes(d.sink_type) || (typeof d.destination === 'string' && /.+@.+/.test(d.destination)),
  { message: 'destination email required for SMTP and Resend sinks', path: ['destination'] },
)

const CreateBody = z.object({
  feed_id: z.string().uuid(),
  label: z.string().max(100).optional().nullable(),
  enabled: z.boolean().default(true),
  destinations: z.array(DestinationInput).min(1).max(20),
})

/**
 * GET → list routes with their destinations joined in.
 *
 * Returned shape:
 *   { routes: [{ id, feed_id, feed_label, feed_url, label, enabled,
 *                destinations: [{id, sink_type, sink_id, destination, enabled,
 *                                sink_label}] }]}
 */
export async function GET() {
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  return withUser(session.uid, async (tx) => {
    const rows = await tx.execute<{
      id: string; feed_id: string; label: string | null; enabled: boolean
      feed_label: string; feed_url: string
    }>(sql`
      SELECT r.id, r.feed_id, r.label, r.enabled,
             f.label AS feed_label, f.url AS feed_url
      FROM routes r
      JOIN feeds f ON f.id = r.feed_id
      ORDER BY r.created_at
    `)
    if (rows.length === 0) return NextResponse.json({ routes: [] })

    const ids = rows.map((r) => r.id)
    const dests = await tx.execute<{
      id: string; route_id: string; sink_type: string; sink_id: string
      destination: string | null; enabled: boolean
      sink_label: string | null
    }>(sql`
      SELECT rd.id, rd.route_id, rd.sink_type, rd.sink_id, rd.destination, rd.enabled,
             COALESCE(ssm.label, sre.label, snt.label, sdw.label) AS sink_label
      FROM route_destinations rd
      LEFT JOIN sinks_smtp           ssm ON rd.sink_type='smtp'            AND ssm.id = rd.sink_id
      LEFT JOIN sinks_resend         sre ON rd.sink_type='resend'          AND sre.id = rd.sink_id
      LEFT JOIN sinks_ntfy           snt ON rd.sink_type='ntfy'            AND snt.id = rd.sink_id
      LEFT JOIN sinks_discord_webhook sdw ON rd.sink_type='discord_webhook' AND sdw.id = rd.sink_id
      WHERE rd.route_id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])
      ORDER BY rd.created_at
    `)
    type Dest = (typeof dests)[number]
    const byRoute = new Map<string, Dest[]>()
    for (const d of dests) {
      const arr = byRoute.get(d.route_id) ?? []
      arr.push(d)
      byRoute.set(d.route_id, arr)
    }
    return NextResponse.json({
      routes: rows.map((r) => ({ ...r, destinations: byRoute.get(r.id) ?? [] })),
    })
  })
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const json = await req.json().catch(() => null)
  const parsed = CreateBody.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
  }
  const ip = clientIp(req)

  return withUser(session.uid, async (tx) => {
    // RLS scopes these checks to the current user.
    const feedExists = await tx.execute(sql`SELECT 1 FROM feeds WHERE id = ${parsed.data.feed_id}::uuid`)
    if (feedExists.length === 0) {
      return NextResponse.json({ error: 'feed-not-found', code: 'feed-not-found' }, { status: 400 })
    }

    // Confirm every requested sink exists and belongs to this user.
    for (const d of parsed.data.destinations) {
      const table = d.sink_type === 'smtp' ? sql`sinks_smtp`
                  : d.sink_type === 'resend' ? sql`sinks_resend`
                  : d.sink_type === 'ntfy' ? sql`sinks_ntfy`
                  : sql`sinks_discord_webhook`
      const rows = await tx.execute(sql`SELECT 1 FROM ${table} WHERE id = ${d.sink_id}::uuid`)
      if (rows.length === 0) {
        return NextResponse.json({ error: 'sink-not-found', code: 'sink-not-found', sink_id: d.sink_id }, { status: 400 })
      }
    }

    // Single tx so route + destinations live or die together.
    const routeRows = await tx.execute<{ id: string }>(sql`
      INSERT INTO routes (user_id, feed_id, label, enabled)
      VALUES (${session.uid}::uuid, ${parsed.data.feed_id}::uuid, ${parsed.data.label ?? null}, ${parsed.data.enabled})
      RETURNING id
    `)
    const routeId = routeRows[0]!.id

    for (const d of parsed.data.destinations) {
      // ntfy/discord_webhook ignore the per-route destination — store NULL.
      const dest = EMAIL_SINK_TYPES.includes(d.sink_type) ? (d.destination ?? null) : null
      await tx.execute(sql`
        INSERT INTO route_destinations (route_id, sink_type, sink_id, destination, enabled)
        VALUES (${routeId}::uuid, ${d.sink_type}, ${d.sink_id}::uuid, ${dest}, ${d.enabled})
      `)
    }

    void writeAudit({
      actor_user_id: session.uid,
      action: 'route.create',
      target_type: 'route',
      target_id: routeId,
      after: parsed.data,
      via: 'web',
      ip,
    })
    void notifyFeedsChanged()
    return NextResponse.json({ ok: true, id: routeId })
  })
}
