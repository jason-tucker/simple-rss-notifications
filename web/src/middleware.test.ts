import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { middleware } from './middleware'

const TOKEN = 'A'.repeat(43)

function passes(path: string): boolean {
  const res = middleware(new NextRequest(`https://app.test${path}`))
  return res.headers.get('x-middleware-next') === '1'
}

test('only /api/hooks/<token-shaped> is public', () => {
  assert.equal(passes(`/api/hooks/${TOKEN}`), true)
  assert.equal(passes(`/api/hooks/${'a_-9'.repeat(8)}`), true, '32 chars')
  assert.equal(passes(`/api/hooks/${'a'.repeat(128)}`), true, '128 chars')

  assert.equal(passes('/api/hooks'), false)
  assert.equal(passes('/api/hooks/'), false)
  assert.equal(passes('/api/hooks/short'), false)
  assert.equal(passes(`/api/hooks/${'a'.repeat(129)}`), false)
  assert.equal(passes(`/api/hooks/${TOKEN}/extra`), false)
  assert.equal(passes(`/api/hooks/${TOKEN}.json`), false)
  assert.equal(passes('/api/hooksXYZ/' + TOKEN), false)
})

test('other public paths still pass and private ones redirect without a cookie', () => {
  assert.equal(passes('/login'), true)
  assert.equal(passes('/api/auth/login'), true)
  const res = middleware(new NextRequest('https://app.test/dashboard'))
  assert.equal(res.status, 307)
  assert.match(res.headers.get('location') ?? '', /\/login\?next=%2Fdashboard$/)
})
