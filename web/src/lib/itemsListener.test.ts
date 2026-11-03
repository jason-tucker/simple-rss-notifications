import { test } from 'node:test'
import assert from 'node:assert/strict'
// Run via: pnpm test (react-server condition stubs `server-only`).
import {
  createItemsHub,
  parseInsertedEvent,
  WATCHDOG_INTERVAL_MS,
  type ListenClient,
  type InsertedEvent,
} from './itemsListener'

/**
 * Controllable stand-in for the postgres-js listen client. `pong: true`
 * echoes pings back through the notify callback (a healthy LISTEN
 * connection); the default never answers (a silently dead one).
 */
function fakeClient(opts: { pong?: boolean } = {}) {
  let notify: (p: string) => void = () => {}
  let onListen: (() => void) | undefined
  let settle!: { resolve: () => void; reject: (e: Error) => void }
  let ended = 0
  let pings = 0
  const client: ListenClient = {
    listen(_channel, fn, ol) {
      notify = fn
      onListen = ol
      return new Promise<void>((resolve, reject) => { settle = { resolve, reject } })
    },
    async ping(payload) {
      pings++
      if (opts.pong) notify(payload)
    },
    async end() { ended++ },
  }
  return {
    client,
    notify: (p: string) => notify(p),
    /** Simulate a successful LISTEN (initial or after a reconnect). */
    listened: () => { onListen?.(); settle.resolve() },
    fail: () => settle.reject(new Error('ECONNREFUSED')),
    get ended() { return ended },
    get pings() { return pings },
  }
}

const tick = () => new Promise((r) => setImmediate(r))

test('parseInsertedEvent accepts {id, feed_id[, user_id]} and rejects junk', () => {
  assert.deepEqual(parseInsertedEvent('{"id":"a","feed_id":"f","user_id":"u"}'), { id: 'a', feed_id: 'f', user_id: 'u' })
  assert.deepEqual(parseInsertedEvent('{"id":"a","feed_id":"f"}'), { id: 'a', feed_id: 'f', user_id: null })
  assert.equal(parseInsertedEvent('{"id":"a","feed_id":"f","user_id":5}'), null)
  assert.equal(parseInsertedEvent('{"id":"a"}'), null)
  assert.equal(parseInsertedEvent('null'), null)
  assert.equal(parseInsertedEvent('not json'), null)
})

test('events fan out to all subscribers; one throwing subscriber does not block others', () => {
  const f = fakeClient()
  const hub = createItemsHub(() => f.client)
  const got: InsertedEvent[] = []
  hub.subscribe({ onEvent: () => { throw new Error('bad subscriber') } })
  hub.subscribe({ onEvent: (e) => got.push(e) })
  f.notify('{"id":"1","feed_id":"f","user_id":"u"}')
  f.notify('garbage')
  assert.deepEqual(got, [{ id: '1', feed_id: 'f', user_id: 'u' }])
})

test('every (re)LISTEN broadcasts a resync', async () => {
  const f = fakeClient()
  const hub = createItemsHub(() => f.client)
  let a = 0
  let b = 0
  hub.subscribe({ onEvent() {}, onResync: () => a++ })
  hub.subscribe({ onEvent() {}, onResync: () => b++ })
  f.listened() // initial LISTEN
  await tick()
  assert.deepEqual([a, b], [1, 1])
  f.listened() // postgres-js re-LISTEN after a dropped connection
  assert.deepEqual([a, b], [2, 2])
})

test('LISTEN failure closes every subscriber via onError and the next subscribe retries', async () => {
  const clients = [fakeClient(), fakeClient()]
  let made = 0
  const hub = createItemsHub(() => clients[made++]!.client)
  const errors: string[] = []
  const unsubs: Array<() => void> = []
  for (const name of ['s1', 's2']) {
    const u = hub.subscribe({
      onEvent() {},
      onError: () => { errors.push(name); u() }, // stream close() unsubscribes
    })
    unsubs.push(u)
  }
  clients[0]!.fail()
  await tick()
  assert.deepEqual(errors.sort(), ['s1', 's2'])
  assert.equal(clients[0]!.ended, 1)
  assert.equal(hub.connected, false)
  assert.equal(hub.subscriberCount, 0)

  hub.subscribe({ onEvent() {} })
  assert.equal(made, 2, 'a fresh client is created for the next subscriber')
  assert.equal(hub.connected, true)
})

test('last unsubscribe ends the client', async () => {
  const f = fakeClient()
  const hub = createItemsHub(() => f.client)
  const u1 = hub.subscribe({ onEvent() {} })
  const u2 = hub.subscribe({ onEvent() {} })
  f.listened()
  u1()
  await tick()
  assert.equal(f.ended, 0)
  u2()
  u2() // idempotent
  await tick()
  assert.equal(f.ended, 1)
  assert.equal(hub.connected, false)
})

test('watchdog: a LISTEN connection that never pongs is replaced and streams resync', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const clients = [fakeClient(), fakeClient()]
  let made = 0
  const hub = createItemsHub(() => clients[made++]!.client)
  let resyncs = 0
  hub.subscribe({ onEvent() {}, onResync: () => resyncs++ })
  clients[0]!.listened()
  await tick()
  assert.equal(resyncs, 1)

  // Ticks at 30 s and 60 s only ping (no pong yet, but under the timeout).
  t.mock.timers.tick(WATCHDOG_INTERVAL_MS * 2)
  assert.equal(clients[0]!.pings, 2)
  assert.equal(made, 1)

  // 90 s > PONG_TIMEOUT_MS: the dead client is ended and replaced.
  t.mock.timers.tick(WATCHDOG_INTERVAL_MS)
  assert.equal(made, 2, 'makeClient called again')
  await tick()
  assert.equal(clients[0]!.ended, 1)
  assert.equal(hub.connected, true)

  // A late onlisten from the old client is ignored; the new LISTEN resyncs.
  clients[0]!.listened()
  assert.equal(resyncs, 1)
  clients[1]!.listened()
  await tick()
  assert.equal(resyncs, 2, 'onResync fired for the new LISTEN')

  // Old interval is gone: only the new client's watchdog pings.
  t.mock.timers.tick(WATCHDOG_INTERVAL_MS)
  assert.equal(clients[0]!.pings, 2)
  assert.equal(clients[1]!.pings, 1)
})

test('watchdog: a healthy (ponging) client is never restarted; other pings are not events', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const f = fakeClient({ pong: true })
  let made = 0
  const hub = createItemsHub(() => { made++; return f.client })
  const got: InsertedEvent[] = []
  hub.subscribe({ onEvent: (e) => got.push(e) })
  f.listened()
  await tick()
  for (let i = 0; i < 10; i++) t.mock.timers.tick(WATCHDOG_INTERVAL_MS)
  assert.equal(f.pings, 10)
  assert.equal(made, 1)
  assert.equal(f.ended, 0)
  f.notify('ping:someone-elses-nonce')
  assert.deepEqual(got, [])
})

test('watchdog stops when the last subscriber leaves', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  let made = 0
  const f = fakeClient()
  const hub = createItemsHub(() => { made++; return f.client })
  const u = hub.subscribe({ onEvent() {} })
  f.listened()
  await tick()
  u()
  for (let i = 0; i < 5; i++) t.mock.timers.tick(WATCHDOG_INTERVAL_MS)
  assert.equal(f.pings, 0)
  assert.equal(made, 1, 'no restart without subscribers')
})
