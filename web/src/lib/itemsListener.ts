import 'server-only'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { env } from '@/lib/env'

/**
 * Process-wide LISTEN items_inserted on ONE dedicated postgres-js
 * connection (LISTEN pins a connection, so it can't come from the query
 * pool). Created when the first SSE subscriber arrives and closed when the
 * last one leaves.
 *
 * Resilience:
 *   - Every successful (re)LISTEN calls our `onlisten` callback, which we
 *     turn into a broadcast `onResync()` so each stream replays from its last
 *     emitted id (anything NOTIFYed while the connection was down is lost).
 *   - After a dropped connection postgres-js tries ONE re-LISTEN itself, but
 *     if that attempt fails it swallows the error (postgres 3.4.x
 *     src/index.js listen() onclose) and the channel is never listened
 *     again, with nothing reported to us. So the hub runs its own watchdog:
 *     every 30 s it NOTIFYs a per-client nonce (`ping:<nonce>`) through the
 *     client's ordinary query connection and expects it back on the LISTEN
 *     connection. If no pong has arrived for 75 s, the client is ended and a
 *     fresh one is created; its LISTEN then either succeeds (onResync, so
 *     streams replay) or fails (below). Worst case, a silent drop is noticed
 *     within ~105 s.
 *   - If a LISTEN fails outright, every subscriber's `onError()` runs so
 *     the streams close and clients reconnect (and re-subscribe).
 *
 * NOTIFY is database-global. The payload ({id, feed_id, user_id}) carries
 * user_id ONLY so subscribers can cheaply skip other users' events; it is
 * not an authorization decision. Subscribers MUST still re-read the item
 * through withUser() (RLS) before emitting it to a client.
 */

export interface InsertedEvent {
  id: string
  feed_id: string
  /** Owner of the feed; null if the publisher predates this field. */
  user_id: string | null
}

export interface ItemsSubscriber {
  onEvent(e: InsertedEvent): void
  /** A (re)LISTEN just completed: replay anything that may have been missed. */
  onResync?(): void
  /** LISTEN failed: close so the client reconnects. */
  onError?(): void
}

/** The slice of a postgres-js client the hub needs (injectable for tests). */
export interface ListenClient {
  listen(channel: string, onNotify: (payload: string) => void, onListen?: () => void): Promise<unknown>
  /** NOTIFY `payload` on the items channel (watchdog self-ping). */
  ping(payload: string): Promise<unknown>
  end(opts?: { timeout?: number }): Promise<unknown>
}

const CHANNEL = 'items_inserted'
/** How often the watchdog pings (and checks for a missing pong). */
export const WATCHDOG_INTERVAL_MS = 30_000
/** No pong for this long: the LISTEN connection is presumed dead. */
export const PONG_TIMEOUT_MS = 75_000

export function parseInsertedEvent(payload: string): InsertedEvent | null {
  try {
    const p = JSON.parse(payload) as Record<string, unknown> | null
    if (!p || typeof p.id !== 'string' || typeof p.feed_id !== 'string') return null
    if (p.user_id !== undefined && typeof p.user_id !== 'string') return null
    return { id: p.id, feed_id: p.feed_id, user_id: typeof p.user_id === 'string' ? p.user_id : null }
  } catch {
    return null
  }
}

export function createItemsHub(makeClient: () => ListenClient) {
  const subs = new Set<ItemsSubscriber>()
  let client: ListenClient | null = null
  let ready: Promise<unknown> | null = null
  let watchdog: ReturnType<typeof setInterval> | null = null

  // Snapshot first: callbacks may unsubscribe (and so mutate `subs`).
  const each = (fn: (s: ItemsSubscriber) => void) => {
    for (const s of [...subs]) {
      try { fn(s) } catch { /* one bad subscriber must not affect others */ }
    }
  }

  function stopWatchdog(): void {
    if (watchdog) clearInterval(watchdog)
    watchdog = null
  }

  function start(): void {
    const c = makeClient()
    client = c
    const ping = 'ping:' + randomUUID()
    let lastPong = Date.now()
    ready = c
      .listen(
        CHANNEL,
        (payload) => {
          if (payload === ping) {
            lastPong = Date.now()
            return
          }
          if (client !== c) return // replaced/ended client: ignore stragglers
          const evt = parseInsertedEvent(payload)
          if (evt) each((s) => s.onEvent(evt))
        },
        () => {
          if (client === c) each((s) => s.onResync?.())
        },
      )
      .catch(() => {
        // Could not LISTEN (DB down). Drop the client so the next
        // subscriber retries, and close every stream so clients reconnect.
        if (client !== c) return
        client = null
        ready = null
        stopWatchdog()
        void c.end({ timeout: 1 }).catch(() => {})
        each((s) => s.onError?.())
      })

    stopWatchdog()
    const timer = setInterval(() => {
      if (client !== c) {
        clearInterval(timer)
        if (watchdog === timer) watchdog = null
        return
      }
      if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
        restart(c)
        return
      }
      void c.ping(ping).catch(() => { /* no pong => restart on a later tick */ })
    }, WATCHDOG_INTERVAL_MS)
    timer.unref?.()
    watchdog = timer
  }

  /** The LISTEN connection went silent: replace the client. */
  function restart(c: ListenClient): void {
    if (client !== c) return
    client = null
    ready = null
    stopWatchdog()
    void c.end({ timeout: 1 }).catch(() => {})
    // The new client's onlisten broadcasts onResync (streams replay).
    if (subs.size > 0) start()
  }

  function subscribe(s: ItemsSubscriber): () => void {
    subs.add(s)
    if (!client) start()
    return () => {
      if (!subs.delete(s)) return
      if (subs.size === 0) stopWatchdog()
      if (subs.size === 0 && client) {
        const c = client
        const r = ready
        client = null
        ready = null
        void Promise.resolve(r).finally(() => c.end({ timeout: 2 }).catch(() => {}))
      }
    }
  }

  return {
    subscribe,
    get subscriberCount() { return subs.size },
    get connected() { return client !== null },
  }
}

function pgListenClient(): ListenClient {
  const c = postgres(env.DATABASE_URL, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: 10,
    connection: { application_name: 'srn-web-items-listener' },
    prepare: false,
    onnotice: () => {},
  })
  return {
    listen: (channel, onNotify, onListen) => c.listen(channel, onNotify, onListen),
    // Base (query) connection, not the LISTEN one: the pong proves the
    // LISTEN connection is still receiving.
    ping: (payload) => c`select pg_notify(${CHANNEL}, ${payload})`,
    end: (opts) => c.end(opts),
  }
}

const hub = createItemsHub(pgListenClient)

export function subscribeItemsInserted(s: ItemsSubscriber): () => void {
  return hub.subscribe(s)
}
