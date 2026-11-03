import { withAuth, checkSessionLive } from '@/lib/auth/withAuth'
import { withUser } from '@/lib/db/withUser'
import { queryItems, UUID_RE, type ItemDto } from '@/lib/items'
import { subscribeItemsInserted } from '@/lib/itemsListener'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEARTBEAT_MS = 15_000
/** Re-validate the session (revoked / expired / password changed) this often. */
const AUTH_RECHECK_MS = 60_000
/** Hard cap on one stream's lifetime; the client reconnects with Last-Event-ID. */
const MAX_LIFETIME_MS = 30 * 60_000
const MAX_STREAMS_PER_USER = 5
const REPLAY_LIMIT = 500
/** Recently emitted ids, so replay/resync and live events never double-send. */
const SEEN_MAX = 1000
/**
 * Bytes we let queue up for a client that is not reading. Past this the
 * stream is ERRORED (controller.error drops the queued data; close() would
 * keep it buffered until drained) and the client resumes from its
 * Last-Event-ID instead of us buffering without bound.
 */
const QUEUE_HIGH_WATER_BYTES = 1024 * 1024
const active = new Map<string, number>()

/**
 * GET /api/items/stream[?feeds=<id,id>]  (Server-Sent Events)
 *   event: item / id: <item id> / data: <ItemDto JSON>
 *   ": hb" comment every 15 s.
 * Reconnect with `Last-Event-ID: <item id>` to replay items received since.
 * Rows are re-read through RLS, so a user only ever receives their own items.
 * The session is re-checked every 60 s and the stream ends after 30 min.
 */
export const GET = withAuth(async (req, { session }) => {
  const uid = session.uid
  if ((active.get(uid) ?? 0) >= MAX_STREAMS_PER_USER) {
    return Response.json({ error: 'too-many-streams', code: 'too-many-streams' }, { status: 429 })
  }

  let feedFilter: Set<string> | null = null
  const feedsParam = req.nextUrl.searchParams.get('feeds')
  if (feedsParam) {
    const ids = feedsParam.split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length > 100 || ids.some((id) => !UUID_RE.test(id))) {
      return Response.json({ error: 'bad-request', detail: 'feeds must be a comma list of feed ids' }, { status: 400 })
    }
    feedFilter = new Set(ids.map((i) => i.toLowerCase()))
  }
  const lastEventId = req.headers.get('last-event-id')
  const replayFrom = lastEventId && UUID_RE.test(lastEventId) ? lastEventId : null
  const uidLower = uid.toLowerCase()

  active.set(uid, (active.get(uid) ?? 0) + 1)
  const enc = new TextEncoder()
  let cleanup: () => void = () => {}

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false
        const startedAt = new Date()
        // Resync cursor: last emitted id, or (nothing emitted yet) connect time.
        let cursorId: string | null = replayFrom
        const seen = new Set<string>()

        const write = (s: string): boolean => {
          if (closed) return false
          // Backpressure: the client is not keeping up. Abort (discarding the
          // queue, which close() would keep) and let it reconnect with
          // Last-Event-ID.
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            close(new DOMException('slow client', 'AbortError'))
            return false
          }
          try {
            controller.enqueue(enc.encode(s))
            return true
          } catch {
            close()
            return false
          }
        }
        const emit = (it: ItemDto) => {
          if (seen.has(it.id)) return
          if (!write(`id: ${it.id}\nevent: item\ndata: ${JSON.stringify(it)}\n\n`)) return
          seen.add(it.id)
          if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string)
          cursorId = it.id
        }

        // Serialize emits so replay + live events keep order. A failed
        // replay/re-read would leave a gap, so end the stream instead and let
        // the client reconnect with Last-Event-ID.
        let chain: Promise<void> = Promise.resolve()
        const enqueueWork = (fn: () => Promise<void>) => {
          chain = chain.then(fn).catch(() => close())
        }

        const replay = () =>
          enqueueWork(async () => {
            if (closed) return
            // If the cursor item has since been deleted, fall back to
            // connect time rather than replaying nothing.
            const since = cursorId ? { sinceId: cursorId, sinceIdFallback: startedAt } : { sinceTime: startedAt }
            const rows = await withUser(uid, (tx) =>
              queryItems(tx, {
                ...since,
                feedIds: feedFilter ? [...feedFilter] : undefined,
                limit: REPLAY_LIMIT,
                order: 'asc',
              }),
            )
            for (const it of rows) emit(it)
          })

        const unsubscribe = subscribeItemsInserted({
          onEvent(evt) {
            // Cheap pre-filter only; the RLS re-read below is the real check.
            if (evt.user_id && evt.user_id.toLowerCase() !== uidLower) return
            if (feedFilter && !feedFilter.has(evt.feed_id.toLowerCase())) return
            if (seen.has(evt.id)) return
            enqueueWork(async () => {
              if (closed || seen.has(evt.id)) return
              const rows = await withUser(uid, (tx) => queryItems(tx, { ids: [evt.id], limit: 1 }))
              for (const it of rows) emit(it)
            })
          },
          // Every (re)LISTEN: replay from the last emitted id in case
          // NOTIFYs were lost while the listener connection was down.
          onResync: replay,
          // LISTEN failed: end the stream so the client reconnects.
          onError: () => close(),
        })

        const hb = setInterval(() => write(': hb\n\n'), HEARTBEAT_MS)
        // Session can be revoked/expired/invalidated after connect; fail
        // closed on DB errors too (the reconnect goes through withAuth).
        const authCheck = setInterval(() => {
          if (closed) return
          checkSessionLive(session).then(
            (r) => { if (!r.ok) close() },
            () => close(),
          )
        }, AUTH_RECHECK_MS)
        const lifetime = setTimeout(() => close(), MAX_LIFETIME_MS)

        /** Graceful end (queued data drains); with `abort`, error the stream and drop the queue. */
        function close(abort?: DOMException) {
          if (closed) return
          closed = true
          clearInterval(hb)
          clearInterval(authCheck)
          clearTimeout(lifetime)
          unsubscribe()
          active.set(uid, Math.max(0, (active.get(uid) ?? 1) - 1))
          try {
            if (abort) controller.error(abort)
            else controller.close()
          } catch { /* already closed */ }
        }
        cleanup = () => close()
        req.signal.addEventListener('abort', () => close())

        write('retry: 3000\n\n: connected\n\n')

        if (replayFrom) replay()
      },
      cancel() {
        cleanup()
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: QUEUE_HIGH_WATER_BYTES }),
  )

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  })
})
