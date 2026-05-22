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

const Body = z.object({
  feed_id: z.string().uuid(),
  sink_type: z.enum(['smtp', 'resend', 'ntfy']),
  sink_id: z.string().uuid(),
  /**
   * Required for email sinks (SMTP/Resend); ignored for ntfy (the ntfy
   * sink already carries server_url + topic, the dispatcher routes there).
   * The refine() below enforces the discrimination.
   */
  destination: z.string().max(320).optional().nullable(),
  label: z.string().max(100).optional().nullable(),
  enabled: z.boolean().default(true),
}).refine(
  (data) => data.sink_type === 'ntfy' || (typeof data.destination === 'string' && /.+@.+/.test(data.destination)),
  { message: 'destination email is required for SMTP and Resend sinks', path: ['destination'] },
)

export async function GET() {
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  return withUser(session.uid, async (tx) => {
    const rows = await tx.execute(sql`
      SELECT r.id, r.feed_id, r.sink_type, r.sink_id, r.destination, r.label, r.enabled,
             r.created_at, r.updated_at,
             f.label AS feed_label, f.url AS feed_url
      FROM routes r
      JOIN feeds f ON f.id = r.feed_id
      ORDER BY r.created_at
    `)
    return NextResponse.json({ routes: rows })
  })
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  const session = await readSessionCookie()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const json = await req.json().catch(() => null)
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
  }
  const ip = clientIp(req)

  return withUser(session.uid, async (tx) => {
    // Validate that the feed AND sink belong to this user via RLS-scoped existence check.
    // (RLS already gates writes; this gives a clearer 400 than a generic constraint error.)
    const feedExists = await tx.execute(sql`SELECT 1 FROM feeds WHERE id = ${parsed.data.feed_id}::uuid`)
    if (feedExists.length === 0) {
      return NextResponse.json({ error: 'feed-not-found', code: 'feed-not-found' }, { status: 400 })
    }
    const sinkTable = parsed.data.sink_type === 'smtp' ? sql`sinks_smtp`
                    : parsed.data.sink_type === 'resend' ? sql`sinks_resend`
                    : sql`sinks_ntfy`
    const sinkExists = await tx.execute(sql`SELECT 1 FROM ${sinkTable} WHERE id = ${parsed.data.sink_id}::uuid`)
    if (sinkExists.length === 0) {
      return NextResponse.json({ error: 'sink-not-found', code: 'sink-not-found' }, { status: 400 })
    }

    // ntfy stores no per-route destination — keep the column NULL.
    const dest = parsed.data.sink_type === 'ntfy' ? null : (parsed.data.destination ?? null)

    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO routes (user_id, feed_id, sink_type, sink_id, destination, label, enabled)
      VALUES (${session.uid}::uuid, ${parsed.data.feed_id}::uuid, ${parsed.data.sink_type}, ${parsed.data.sink_id}::uuid,
              ${dest}, ${parsed.data.label ?? null}, ${parsed.data.enabled})
      RETURNING id
    `)
    const id = rows[0]!.id
    void writeAudit({
      actor_user_id: session.uid,
      action: 'route.create',
      target_type: 'route',
      target_id: id,
      after: parsed.data,
      via: 'web',
      ip,
    })
    return NextResponse.json({ ok: true, id })
  })
}
