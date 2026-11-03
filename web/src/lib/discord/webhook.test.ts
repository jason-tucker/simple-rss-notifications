import { test } from 'node:test'
import assert from 'node:assert/strict'
// Run via: pnpm test (react-server condition stubs `server-only`).
import { buildDiscordBody } from './webhook'

const base = { username: null, avatar_url: null }

test('allowed_mentions.parse is empty in embed mode (default and caller embed)', () => {
  const a = buildDiscordBody({ ...base, use_embeds: true }, { title: '@everyone', message: '@here <@&123>' })
  assert.deepEqual(a.allowed_mentions, { parse: [] })
  const b = buildDiscordBody({ ...base, use_embeds: true }, { message: 'x', embed: { title: '@everyone' } })
  assert.deepEqual(b.allowed_mentions, { parse: [] })
  assert.deepEqual(b.embeds, [{ title: '@everyone' }])
})

test('allowed_mentions.parse is empty in content mode', () => {
  const c = buildDiscordBody(
    { username: 'Bot', avatar_url: 'https://a.test/x.png', use_embeds: false },
    { title: 'T', message: '@everyone ping', link: 'https://l.test' },
  )
  assert.deepEqual(c.allowed_mentions, { parse: [] })
  assert.equal(c.content, 'T\n@everyone ping\nhttps://l.test')
  assert.equal(c.username, 'Bot')
  // Survives JSON serialization exactly as Discord expects.
  assert.ok(JSON.stringify(c).includes('"allowed_mentions":{"parse":[]}'))
})
