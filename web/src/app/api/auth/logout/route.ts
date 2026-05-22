import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { readSessionCookie, clearSessionCookie } from '@/lib/auth/session'
import { isSameOrigin } from '@/lib/auth/csrf'

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: 'forbidden', code: 'csrf' }, { status: 403 })
  }

  // Best-effort: delete the server-side mirror so the cookie is dead even
  // if the browser ignores our Set-Cookie. A missing session here just
  // means already-logged-out; that's success too.
  const session = await readSessionCookie()
  if (session) {
    await db.execute(sql`DELETE FROM web_sessions WHERE jti = ${session.jti}`).catch(() => {})
  }

  await clearSessionCookie()
  return NextResponse.json({ ok: true })
}
