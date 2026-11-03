import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
// Run via: pnpm test (react-server condition stubs `server-only`).
import { handleHook, LOOKUP_BUDGET, PER_FEED, PER_IP_BAD, PER_USER, type HookDeps } from './handler'
import { MAX_KEYS, untrustedLimiter } from './rateLimit'
import type { WebhookFeed } from './ingest'

const tok = () => randomBytes(32).toString('base64url')

function post(token: string, body = 'hello'): Request {
  return new Request(`http://x/api/hooks/${token}`, { method: 'POST', body })
}

function deps(feeds: Map<string, WebhookFeed>) {
  const calls = { find: 0, ingest: 0 }
  const d: HookDeps = {
    findFeed: async (t) => {
      calls.find++
      return feeds.get(t) ?? null
    },
    ingest: async () => {
      calls.ingest++
      return { id: 'item-' + calls.ingest, receivedAt: new Date(0) }
    },
  }
  return { d, calls }
}

function feed(id: string, userId: string, enabled = true): WebhookFeed {
  return { id, user_id: userId, label: 'F-' + id, enabled }
}

test('31 random tokens from one IP: #31 is 429 without a lookup', async () => {
  const { d, calls } = deps(new Map())
  const ip = '198.51.100.1'
  for (let i = 1; i <= PER_IP_BAD.limit; i++) {
    const r = await handleHook(post(tok()), tok(), ip, d)
    assert.equal(r.status, 404, `request ${i}`)
  }
  assert.equal(calls.find, PER_IP_BAD.limit)

  const r31 = await handleHook(post(tok()), tok(), ip, d)
  assert.equal(r31.status, 429)
  assert.ok(Number(r31.headers.get('retry-after')) >= 1)
  assert.equal(calls.find, PER_IP_BAD.limit, 'lookup NOT called for #31')

  // Malformed tokens are also short-circuited, and other IPs are unaffected.
  assert.equal((await handleHook(post('x'), 'x', ip, d)).status, 429)
  assert.equal((await handleHook(post(tok()), tok(), '198.51.100.2', d)).status, 404)
})

test('throttled IP is blocked even for a valid token (slot reserved before lookup)', async () => {
  const good = tok()
  const { d, calls } = deps(new Map([[good, feed('f-peek', 'u-peek')]]))
  const ip = '198.51.100.3'
  for (let i = 0; i < PER_IP_BAD.limit; i++) await handleHook(post('bad'), 'bad', ip, d)
  assert.equal(calls.find, 0, 'malformed tokens never reach the lookup')
  assert.equal((await handleHook(post(good), good, ip, d)).status, 429)
  assert.equal(calls.find, 0)
})

test('filling the untrusted store with 10,001 bad keys does not reset a feed bucket', async () => {
  const good = tok()
  const { d, calls } = deps(new Map([[good, feed('f-evict', 'u-evict')]]))
  for (let i = 0; i < PER_FEED.limit; i++) {
    assert.equal((await handleHook(post(good), good, '203.0.113.1', d)).status, 204)
  }
  assert.equal((await handleHook(post(good), good, '203.0.113.1', d)).status, 429, 'feed bucket full')

  for (let i = 0; i < MAX_KEYS + 1; i++) {
    const r = await handleHook(post('bad'), 'bad', `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, d)
    assert.equal(r.status, 404)
  }
  assert.ok(untrustedLimiter.size <= MAX_KEYS, 'untrusted store stays capped')

  const after = await handleHook(post(good), good, '203.0.113.1', d)
  assert.equal(after.status, 429, 'feed bucket survived the flood')
  assert.equal(calls.ingest, PER_FEED.limit)
})

test('per-feed bucket is keyed by feed id, not created for unknown/disabled feeds', async () => {
  const off = tok()
  const { d, calls } = deps(new Map([[off, feed('f-off', 'u-off', false)]]))
  const r = await handleHook(post(off), off, '203.0.113.9', d)
  assert.equal(r.status, 404)
  assert.equal(calls.ingest, 0)
})

test('per-user cap applies across all of a user\'s hooks', async () => {
  const tokens = [tok(), tok(), tok()]
  const feeds = new Map(tokens.map((t, i) => [t, feed(`f-u${i}`, 'u-multi')]))
  const other = tok()
  feeds.set(other, feed('f-other', 'u-other'))
  const { d } = deps(feeds)
  // 120 requests spread over 3 feeds (40 each, under the 60/feed limit).
  for (let i = 0; i < PER_USER.limit; i++) {
    const t = tokens[i % 3]!
    assert.equal((await handleHook(post(t), t, '203.0.113.2', d)).status, 204, `request ${i + 1}`)
  }
  const capped = await handleHook(post(tokens[0]!), tokens[0]!, '203.0.113.2', d)
  assert.equal(capped.status, 429)
  // A different user is unaffected.
  assert.equal((await handleHook(post(other), other, '203.0.113.2', d)).status, 204)
})

test('normalizer exceptions become 400, not 500', async (t) => {
  t.mock.method(console, 'error', () => {})
  const good = tok()
  const { d, calls } = deps(new Map([[good, feed('f-throw', 'u-throw')]]))
  const req = {
    url: `http://x/api/hooks/${good}`,
    body: null,
    headers: {
      get(name: string) {
        if (name === 'content-length' || name === 'content-type') return null
        throw new Error('boom')
      },
    },
  } as unknown as Request
  const r = await handleHook(req, good, '203.0.113.3', d)
  assert.equal(r.status, 400)
  assert.deepEqual(await r.json(), { error: 'bad-payload' })
  assert.equal(calls.ingest, 0)
})

test('?wait=true returns the item JSON; default is 204', async () => {
  const good = tok()
  const { d } = deps(new Map([[good, feed('f-wait', 'u-wait')]]))
  const r = await handleHook(
    new Request(`http://x/api/hooks/${good}?wait=true`, { method: 'POST', body: 'hi' }),
    good,
    '203.0.113.4',
    d,
  )
  assert.equal(r.status, 200)
  const j = (await r.json()) as { feed_id: string; content: string }
  assert.equal(j.feed_id, 'f-wait')
  assert.equal(j.content, 'hi')
  assert.equal(JSON.stringify(j).includes(good), false, 'token never echoed')
})

/** findFeed that resolves only after a macrotask, so calls really overlap. */
function slowDeps(feeds: Map<string, WebhookFeed>) {
  const calls = { find: 0, ingest: 0 }
  const d: HookDeps = {
    findFeed: async (t) => {
      calls.find++
      await new Promise((r) => setTimeout(r, 5))
      return feeds.get(t) ?? null
    },
    ingest: async () => {
      calls.ingest++
      return { id: 'item-' + calls.ingest, receivedAt: new Date(0) }
    },
  }
  return { d, calls }
}

test('1000 concurrent unknown tokens from one IP: at most PER_IP_BAD lookups', async () => {
  const { d, calls } = slowDeps(new Map())
  const ip = '198.51.100.50'
  const res = await Promise.all(Array.from({ length: 1000 }, () => {
    const t = tok()
    return handleHook(post(t), t, ip, d)
  }))
  assert.ok(calls.find <= PER_IP_BAD.limit, `findFeed called ${calls.find} times`)
  assert.equal(res.filter((r) => r.status === 404).length, calls.find)
  assert.equal(res.filter((r) => r.status === 429).length, 1000 - calls.find)
})

test('valid tokens refund their reserved bad-token slot (concurrent, one IP)', async () => {
  const good = tok()
  const { d, calls } = slowDeps(new Map([[good, feed('f-conc', 'u-conc')]]))
  const ip = '198.51.100.51'
  // 30 concurrent valid requests hold every reserved slot at once...
  const first = await Promise.all(Array.from({ length: PER_IP_BAD.limit }, () => handleHook(post(good), good, ip, d)))
  assert.ok(first.every((r) => r.status === 204))
  // ...and all were refunded, so the IP's bad-token budget is untouched.
  for (let i = 0; i < PER_IP_BAD.limit; i++) {
    assert.equal((await handleHook(post(tok()), tok(), ip, d)).status, 404, `bad #${i + 1}`)
  }
  assert.equal((await handleHook(post(tok()), tok(), ip, d)).status, 429)
  assert.equal(calls.ingest, PER_IP_BAD.limit)
})

// Keep LAST: it exhausts the process-wide lookup budget for the window.
test('process-wide lookup budget caps misses across many IPs', async () => {
  const { d, calls } = slowDeps(new Map())
  // A fresh window regardless of earlier tests' buckets.
  const t0 = Date.now() + 10 * 60_000
  const dd: HookDeps = { ...d, now: () => t0 }
  const res = await Promise.all(Array.from({ length: 1000 }, (_, i) => {
    const t = tok()
    return handleHook(post(t), t, `10.200.${(i >> 8) & 255}.${i & 255}`, dd)
  }))
  assert.equal(calls.find, LOOKUP_BUDGET.limit)
  assert.equal(res.filter((r) => r.status === 429).length, 1000 - LOOKUP_BUDGET.limit)
  // Rejected-by-budget requests got their per-IP slot back.
  const ip999 = '10.200.3.231'
  assert.equal(untrustedLimiter.peek(`bad:${ip999}`, 1, 60_000, t0).ok, true)
})
