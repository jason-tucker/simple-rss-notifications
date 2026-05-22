import postgres from 'postgres'
import { env } from '@/lib/env'

type Logger = (msg: string, extra?: Record<string, unknown>) => void

/**
 * Postgres LISTEN/NOTIFY subscriber for the worker.
 *
 * The web API emits NOTIFY on `feeds_changed` (route/feed/destination
 * CRUD) and `dispatches_changed` (retry button). The worker LISTENs on
 * both and exposes a Promise-like `waitForKick()` that resolves as soon
 * as a notification arrives. The work loop uses it as a wakeup signal —
 * instead of sleeping a fixed 2 s, it `await`s either the timer OR a
 * NOTIFY, whichever fires first.
 *
 * Why a SEPARATE postgres-js client: LISTEN holds a connection in a
 * special mode (the connection is blocked waiting for notices), so we
 * can't share it with the regular query pool. The dedicated listener
 * is single-connection, no pool.
 *
 * postgres-js's listener also auto-reconnects, but it does NOT replay
 * LISTEN on reconnect — we explicitly resubscribe on every (re)connect
 * via the `onConnect` option.
 */

export const CHANNELS = ['feeds_changed', 'dispatches_changed'] as const

export type NotifyKick = () => Promise<void>

export interface NotifySubscriber {
  /**
   * Resolves the next time a NOTIFY is received on any subscribed
   * channel. The promise is rotated every kick so the next call gets
   * a fresh promise for the next event.
   */
  waitForKick: NotifyKick
  close(): Promise<void>
}

export async function startNotifySubscriber(log: Logger): Promise<NotifySubscriber> {
  // Standalone connection — postgres-js LISTEN blocks the underlying
  // socket, so this client has its own connection (max: 1, no pool sharing).
  const sub = postgres(env.DATABASE_URL, {
    max: 1,
    idle_timeout: 0,            // never idle-disconnect the listener
    connect_timeout: 10,
    connection: { application_name: 'srn-worker-listener' },
    prepare: false,
    onnotice: () => {},
  })

  // Rotating promise pattern: every NOTIFY resolves `current` and rolls
  // a fresh one in. Callers `await waitForKick()` and get woken once.
  let resolve: () => void = () => {}
  let current = new Promise<void>((r) => { resolve = r })
  function kick() {
    const r = resolve
    current = new Promise<void>((next) => { resolve = next })
    r()
  }

  for (const channel of CHANNELS) {
    await sub.listen(channel, () => kick(), () => {
      log('notify-resubscribed', { channel })
    })
  }
  log('notify-subscriber-ready', { channels: [...CHANNELS] })

  return {
    waitForKick: () => current,
    async close() {
      await sub.end({ timeout: 2 }).catch(() => {})
    },
  }
}

/**
 * Convenience: await EITHER a notification OR a timeout. The work loop
 * uses this so it sleeps `idleSleepMs` between polls but wakes
 * immediately when the UI changes config.
 */
export function sleepUntilKickOrMs(sub: NotifySubscriber, ms: number): Promise<void> {
  return Promise.race([
    sub.waitForKick(),
    new Promise<void>((r) => setTimeout(r, ms).unref()),
  ])
}
