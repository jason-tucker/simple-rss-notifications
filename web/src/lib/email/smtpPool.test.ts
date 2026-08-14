import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KeyedTransportCache, connectionFingerprint } from './smtpPool'

function makeCache(idleMs = 1000) {
  const closed: string[] = []
  const cache = new KeyedTransportCache<string>((v) => closed.push(v), idleMs)
  return { cache, closed }
}

test('hit: same key + fingerprint returns the cached value', () => {
  const { cache, closed } = makeCache()
  cache.set('sink1', 'fp-a', 'transport-1', 0)
  assert.equal(cache.get('sink1', 'fp-a', 1), 'transport-1')
  assert.equal(cache.get('sink1', 'fp-a', 2), 'transport-1')
  assert.deepEqual(closed, [])
})

test('fingerprint change closes the old transport and misses', () => {
  const { cache, closed } = makeCache()
  cache.set('sink1', 'fp-a', 'transport-1', 0)
  assert.equal(cache.get('sink1', 'fp-b', 1), null)
  assert.deepEqual(closed, ['transport-1'])
  assert.equal(cache.size, 0)
})

test('set over an existing entry closes the replaced transport', () => {
  const { cache, closed } = makeCache()
  cache.set('sink1', 'fp-a', 'transport-1', 0)
  cache.set('sink1', 'fp-b', 'transport-2', 1)
  assert.deepEqual(closed, ['transport-1'])
  assert.equal(cache.get('sink1', 'fp-b', 2), 'transport-2')
})

test('drop closes and forgets; dropping a missing key is a no-op', () => {
  const { cache, closed } = makeCache()
  cache.set('sink1', 'fp-a', 'transport-1', 0)
  cache.drop('sink1')
  cache.drop('sink1')
  assert.deepEqual(closed, ['transport-1'])
  assert.equal(cache.get('sink1', 'fp-a', 1), null)
})

test('idle entries are swept on access', () => {
  const { cache, closed } = makeCache(1000)
  cache.set('sink1', 'fp-a', 'transport-1', 0)
  cache.set('sink2', 'fp-b', 'transport-2', 0)
  // Touch sink2 to keep it fresh, then advance past idleMs for sink1.
  assert.equal(cache.get('sink2', 'fp-b', 900), 'transport-2')
  assert.equal(cache.get('sink2', 'fp-b', 1500), 'transport-2')
  assert.deepEqual(closed, ['transport-1'])
  assert.equal(cache.size, 1)
})

test('a throwing close function does not break the cache', () => {
  const cache = new KeyedTransportCache<string>(() => { throw new Error('boom') }, 1000)
  cache.set('sink1', 'fp-a', 'transport-1', 0)
  cache.drop('sink1')
  assert.equal(cache.size, 0)
})

test('connectionFingerprint is stable and order/value sensitive', () => {
  const a = connectionFingerprint(['smtp.example.com', 587, 'user', true, 1, 'ct-base64'])
  const b = connectionFingerprint(['smtp.example.com', 587, 'user', true, 1, 'ct-base64'])
  const c = connectionFingerprint(['smtp.example.com', 587, 'user', true, 2, 'ct-base64'])
  const d = connectionFingerprint(['smtp.example.com', 465, 'user', true, 1, 'ct-base64'])
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.notEqual(a, d)
  // Field boundaries survive serialization (no naive join ambiguity).
  assert.notEqual(connectionFingerprint(['ab', 'c']), connectionFingerprint(['a', 'bc']))
})
