import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backoffSec, parseRetryAfterSec, retryDelaySec, retryAfterHintSec, isPermanentFailure, MAX_RETRY_DELAY_SEC } from './retry'

test('backoffSec follows 60/300/1500/3600/3600', () => {
  assert.equal(backoffSec(1), 60)
  assert.equal(backoffSec(2), 300)
  assert.equal(backoffSec(3), 1500)
  assert.equal(backoffSec(4), 3600)
  assert.equal(backoffSec(5), 3600)
  assert.equal(backoffSec(0), 60) // defensive: attempts never < 1 in practice
})

test('parseRetryAfterSec handles delta-seconds', () => {
  assert.equal(parseRetryAfterSec('120'), 120)
  assert.equal(parseRetryAfterSec(' 30 '), 30)
  assert.equal(parseRetryAfterSec('0'), 0)
})

test('parseRetryAfterSec handles HTTP-date', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  assert.equal(parseRetryAfterSec('Thu, 01 Jan 2026 00:02:00 GMT', now), 120)
  // A date in the past clamps to 0, not negative.
  assert.equal(parseRetryAfterSec('Wed, 31 Dec 2025 23:00:00 GMT', now), 0)
})

test('parseRetryAfterSec rejects garbage', () => {
  assert.equal(parseRetryAfterSec(undefined), null)
  assert.equal(parseRetryAfterSec(null), null)
  assert.equal(parseRetryAfterSec(''), null)
  assert.equal(parseRetryAfterSec('soon'), null)
  assert.equal(parseRetryAfterSec('12.5.3'), null)
})

test('retryDelaySec takes the max of backoff and server hint, capped', () => {
  assert.equal(retryDelaySec(1), 60)                    // no hint → backoff
  assert.equal(retryDelaySec(1, null), 60)
  assert.equal(retryDelaySec(1, 0), 60)                 // zero/negative hint ignored
  assert.equal(retryDelaySec(1, 120), 120)              // hint above backoff wins
  assert.equal(retryDelaySec(2, 120), 300)              // backoff above hint wins
  assert.equal(retryDelaySec(1, 999999), MAX_RETRY_DELAY_SEC) // hostile hint capped
})

test('429 is transient for every provider', () => {
  assert.equal(isPermanentFailure('ntfy-http-429'), false)
  assert.equal(isPermanentFailure('discord-http-429'), false)
  assert.equal(isPermanentFailure('resend-http-429'), false)
})

test('other 4xx stay permanent — including future sink types', () => {
  assert.equal(isPermanentFailure('ntfy-http-401'), true)
  assert.equal(isPermanentFailure('ntfy-http-403'), true)
  assert.equal(isPermanentFailure('discord-http-404'), true)
  assert.equal(isPermanentFailure('resend-http-422'), true)
  assert.equal(isPermanentFailure('slack-http-400'), true) // generic suffix rule
  assert.equal(isPermanentFailure('slack-http-429'), false)
})

test('retryAfterHintSec merges Retry-After and X-RateLimit-Reset-After on 429', () => {
  const headers = (m: Record<string, string>) => ({ get: (n: string) => m[n.toLowerCase()] ?? null })
  assert.equal(retryAfterHintSec(headers({ 'retry-after': '30' }), 429), 30)
  assert.equal(retryAfterHintSec(headers({ 'x-ratelimit-reset-after': '12.3' }), 429), 13)
  assert.equal(retryAfterHintSec(headers({ 'retry-after': '30', 'x-ratelimit-reset-after': '45.1' }), 429), 46)
  assert.equal(retryAfterHintSec(headers({}), 429), undefined)
  assert.equal(retryAfterHintSec(headers({ 'retry-after': '30' }), 500), undefined) // only 429s carry hints
  assert.equal(retryAfterHintSec(headers({ 'x-ratelimit-reset-after': 'garbage' }), 429), undefined)
})

test('config errors stay permanent, transient stays transient', () => {
  assert.equal(isPermanentFailure('sink-incomplete'), true)
  assert.equal(isPermanentFailure('decrypt-failed'), true)
  assert.equal(isPermanentFailure('ssrf-blocked'), true)
  assert.equal(isPermanentFailure('EAUTH'), true)
  assert.equal(isPermanentFailure('EENVELOPE'), true)
  assert.equal(isPermanentFailure('ntfy-http-500'), false)
  assert.equal(isPermanentFailure('discord-http-503'), false)
  assert.equal(isPermanentFailure('smtp-connection'), false)
  assert.equal(isPermanentFailure('resend-network'), false)
  assert.equal(isPermanentFailure(undefined), false)
})
