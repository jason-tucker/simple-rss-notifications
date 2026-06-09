import { test } from 'node:test'
import assert from 'node:assert/strict'
// Run via: pnpm test  (node --conditions=react-server --import tsx --test).
// The react-server condition stubs the `server-only` import in ssrf.ts so the
// pure IP-classification logic can be exercised outside a Next request.
import { isPrivateAddress, isPrivateHost } from '@/lib/ssrf'

/**
 * Pure IP-classification tests for the SSRF guard. These lock in the
 * hardened IPv6 handling (IPv4-mapped hex form, NAT64, 6to4) plus the
 * existing IPv4 ranges.
 *
 * Run: node --import tsx --test src/lib/ssrf.test.ts
 */

// Addresses that MUST be rejected (private / reserved / internal).
const MUST_REJECT = [
  '::ffff:127.0.0.1', // IPv4-mapped loopback (dotted)
  '::ffff:7f00:1', // IPv4-mapped loopback (hex form) — previously MISSED
  '64:ff9b::7f00:1', // NAT64 of 127.0.0.1 — previously MISSED
  '2002:7f00:1::', // 6to4 embedding 127.0.0.1 — previously MISSED
  '169.254.169.254', // cloud metadata
  '10.0.0.1', // RFC1918
  '127.0.0.1', // loopback
  '0.0.0.0', // this host / unspecified
  '::1', // IPv6 loopback
  '::', // IPv6 unspecified
  'fe80::1', // link-local
  'fc00::1', // ULA
  'fd12:3456::1', // ULA
  'ff02::1', // multicast
  '192.168.1.1', // RFC1918
  '172.16.0.1', // RFC1918
  '100.64.0.1', // CGNAT
  '64:ff9b::a00:1', // NAT64 of 10.0.0.1
  '2002:c0a8:101::', // 6to4 embedding 192.168.1.1
]

// Addresses that MUST be accepted (publicly routable).
const MUST_ACCEPT = [
  '93.184.216.34', // example.com-ish public v4
  '8.8.8.8',
  '1.1.1.1',
  '2606:4700:4700::1111', // public v6 (Cloudflare DNS)
  '::ffff:8.8.8.8', // IPv4-mapped public address
  '2002:5db8:d822::', // 6to4 embedding a public v4 (93.184.216.34)
]

test('isPrivateAddress rejects private/reserved/internal addresses', () => {
  for (const ip of MUST_REJECT) {
    assert.equal(isPrivateAddress(ip), true, `expected ${ip} to be REJECTED (private)`)
  }
})

test('isPrivateAddress accepts public addresses', () => {
  for (const ip of MUST_ACCEPT) {
    assert.equal(isPrivateAddress(ip), false, `expected ${ip} to be ACCEPTED (public)`)
  }
})

test('isPrivateAddress treats garbage as unsafe', () => {
  assert.equal(isPrivateAddress('not-an-ip'), true)
  assert.equal(isPrivateAddress('999.999.999.999'), true)
  assert.equal(isPrivateAddress(''), true)
})

test('isPrivateHost resolves literal IPs directly', async () => {
  // Literal private IPs → host is private (refuse).
  assert.equal(await isPrivateHost('127.0.0.1'), true)
  assert.equal(await isPrivateHost('10.0.0.1'), true)
  assert.equal(await isPrivateHost('169.254.169.254'), true)
  assert.equal(await isPrivateHost('::ffff:7f00:1'), true)
  // Literal public IP → not private (allow).
  assert.equal(await isPrivateHost('8.8.8.8'), false)
  // Local hostnames → refuse without DNS.
  assert.equal(await isPrivateHost('localhost'), true)
  assert.equal(await isPrivateHost('db.local'), true)
})
