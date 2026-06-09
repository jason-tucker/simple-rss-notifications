import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSafeUrl, isSafeHttpUrl } from './url'

// Run with the tsx loader (resolves extensionless TS imports + path aliases):
//   node --import tsx --test src/lib/url.test.ts
// (On Node >= 23.6 type-stripping is on by default; the flag is harmless.)

test('isSafeHttpUrl rejects dangerous schemes', () => {
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false)
  assert.equal(isSafeHttpUrl('data:text/html,<script>alert(1)</script>'), false)
  assert.equal(isSafeHttpUrl('vbscript:msgbox(1)'), false)
  // Case tricks.
  assert.equal(isSafeHttpUrl('JaVaScRiPt:alert(1)'), false)
  // Leading-whitespace trick.
  assert.equal(isSafeHttpUrl('   javascript:alert(1)'), false)
  // Embedded control-char trick (tab inside the scheme).
  assert.equal(isSafeHttpUrl('java\tscript:alert(1)'), false)
  // Embedded newline trick.
  assert.equal(isSafeHttpUrl('java\nscript:alert(1)'), false)
  // Embedded NUL trick.
  assert.equal(isSafeHttpUrl('java\0script:alert(1)'), false)
  // mailto and relative are NOT http(s) — rejected by the strict variant.
  assert.equal(isSafeHttpUrl('mailto:someone@example.com'), false)
  assert.equal(isSafeHttpUrl('/relative/path'), false)
  assert.equal(isSafeHttpUrl('file:///etc/passwd'), false)
})

test('isSafeHttpUrl accepts http and https', () => {
  assert.equal(isSafeHttpUrl('https://example.com/x'), true)
  assert.equal(isSafeHttpUrl('http://example.com'), true)
  assert.equal(isSafeHttpUrl('HTTPS://EXAMPLE.COM/Path'), true)
  // Leading whitespace around a legit URL is tolerated.
  assert.equal(isSafeHttpUrl('  https://example.com  '), true)
})

test('isSafeUrl rejects dangerous schemes', () => {
  assert.equal(isSafeUrl('javascript:alert(1)'), false)
  assert.equal(isSafeUrl('data:text/html,<script>alert(1)</script>'), false)
  assert.equal(isSafeUrl('vbscript:msgbox(1)'), false)
  assert.equal(isSafeUrl('JaVaScRiPt:alert(1)'), false)
  assert.equal(isSafeUrl('   javascript:alert(1)'), false)
  assert.equal(isSafeUrl('java\tscript:alert(1)'), false)
  assert.equal(isSafeUrl('java\nscript:alert(1)'), false)
  assert.equal(isSafeUrl('java\0script:alert(1)'), false)
  assert.equal(isSafeUrl('file:///etc/passwd'), false)
})

test('isSafeUrl accepts http(s), mailto, and relative', () => {
  assert.equal(isSafeUrl('https://example.com/x'), true)
  assert.equal(isSafeUrl('http://example.com'), true)
  assert.equal(isSafeUrl('mailto:someone@example.com'), true)
  assert.equal(isSafeUrl('/relative/path'), true)
  assert.equal(isSafeUrl('relative/path?q=1'), true)
})
