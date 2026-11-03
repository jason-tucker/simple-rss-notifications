import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
// Run via: pnpm test (react-server condition stubs `server-only`).
import { queryItems } from './items'

/** Capture the SQL queryItems would run (no database needed). */
async function render(q: Parameters<typeof queryItems>[1]) {
  let captured: SQL | undefined
  const tx = { execute: async (s: SQL) => { captured = s; return [] } }
  await queryItems(tx as unknown as Parameters<typeof queryItems>[0], q)
  return new PgDialect().sqlToQuery(captured!)
}

const ID = '11111111-1111-4111-8111-111111111111'

test('sinceId with sinceIdFallback falls back to the fallback time when the cursor row is gone', async () => {
  const at = new Date('2026-01-02T03:04:05.000Z')
  const { sql, params } = await render({ sinceId: ID, sinceIdFallback: at, limit: 10, order: 'asc' })
  const flat = sql.replace(/\s+/g, ' ')
  assert.match(flat, /\(fi\.fetched_at, fi\.id\) > \( SELECT c\.fetched_at, c\.id FROM \(/)
  assert.match(flat, /UNION ALL SELECT \$\d+::timestamptz, '00000000-0000-0000-0000-000000000000'::uuid, 1/)
  assert.match(flat, /ORDER BY c\.pri LIMIT 1/)
  assert.ok(params.includes(ID))
  assert.ok(params.includes(at.toISOString()))
})

test('sinceId without a fallback keeps the strict cursor comparison', async () => {
  const { sql, params } = await render({ sinceId: ID, limit: 10 })
  const flat = sql.replace(/\s+/g, ' ')
  assert.match(flat, /\(fi\.fetched_at, fi\.id\) > \(SELECT fetched_at, id FROM feed_items WHERE id = \$\d+::uuid\)/)
  assert.doesNotMatch(flat, /UNION ALL/)
  assert.deepEqual(params.filter((p) => p === ID).length, 1)
})
