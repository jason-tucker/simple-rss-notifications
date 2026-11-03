import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/withAuth'
import { withUser } from '@/lib/db/withUser'
import { queryItems, UUID_RE } from '@/lib/items'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

/**
 * GET /api/items?feeds=<id,id>&since=<ISO|item id>&limit=<=500
 * Newest-first. `since` is exclusive (items received after it).
 */
export const GET = withAuth(async (req, { session }) => {
  const p = req.nextUrl.searchParams

  let feedIds: string[] | undefined
  const feedsParam = p.get('feeds')
  if (feedsParam) {
    feedIds = feedsParam.split(',').map((s) => s.trim()).filter(Boolean)
    if (feedIds.length > 100 || feedIds.some((id) => !UUID_RE.test(id))) {
      return NextResponse.json({ error: 'bad-request', detail: 'feeds must be a comma list of feed ids' }, { status: 400 })
    }
  }

  let sinceTime: Date | undefined
  let sinceId: string | undefined
  const since = p.get('since')
  if (since) {
    if (UUID_RE.test(since)) sinceId = since
    else {
      const d = new Date(since)
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'bad-request', detail: 'since must be an ISO timestamp or item id' }, { status: 400 })
      }
      sinceTime = d
    }
  }

  const limitRaw = p.get('limit')
  let limit = DEFAULT_LIMIT
  if (limitRaw !== null) {
    const n = Number(limitRaw)
    if (!Number.isInteger(n) || n < 1) {
      return NextResponse.json({ error: 'bad-request', detail: 'limit must be a positive integer' }, { status: 400 })
    }
    limit = Math.min(n, MAX_LIMIT)
  }

  const items = await withUser(session.uid, (tx) => queryItems(tx, { feedIds, sinceTime, sinceId, limit }))
  return NextResponse.json(items, { headers: { 'Cache-Control': 'no-store' } })
})
