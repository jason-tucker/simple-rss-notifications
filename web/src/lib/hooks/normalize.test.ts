import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_BODY_BYTES,
  MAX_JSON_DEPTH,
  exceedsDepth,
  normalizeHook,
  parseColor,
  parseDate,
  parsePriority,
  readBodyLimited,
  safeUrl,
  sanitizeJson,
  textToHtml,
} from './normalize'
import { FixedWindowLimiter } from './rateLimit'

function run(
  body: string,
  opts: { ct?: string; headers?: Record<string, string>; query?: string; feed?: string } = {},
) {
  const h = new Headers(opts.headers ?? {})
  return normalizeHook({
    body,
    contentType: opts.ct ?? null,
    headers: h,
    query: new URLSearchParams(opts.query ?? ''),
    feedName: opts.feed ?? 'My Feed',
  })
}

test('parsePriority accepts numbers and names, clamps, rejects junk', () => {
  assert.equal(parsePriority(1), 1)
  assert.equal(parsePriority(5), 5)
  assert.equal(parsePriority(9), 5)
  assert.equal(parsePriority(0), 1)
  assert.equal(parsePriority('4'), 4)
  assert.equal(parsePriority('min'), 1)
  assert.equal(parsePriority('LOW'), 2)
  assert.equal(parsePriority('default'), 3)
  assert.equal(parsePriority('high'), 4)
  assert.equal(parsePriority('urgent'), 5)
  assert.equal(parsePriority('max'), 5)
  assert.equal(parsePriority('u=3, i'), undefined)
  assert.equal(parsePriority(''), undefined)
  assert.equal(parsePriority(null), undefined)
  assert.equal(parsePriority(NaN), undefined)
})

test('parseColor handles ints and hex strings', () => {
  assert.equal(parseColor(16711680), '#ff0000')
  assert.equal(parseColor(255), '#0000ff')
  assert.equal(parseColor('#ABC'), '#aabbcc')
  assert.equal(parseColor('00ff00'), '#00ff00')
  assert.equal(parseColor(-1), null)
  assert.equal(parseColor(0x1000000), null)
  assert.equal(parseColor('red'), null)
})

test('discord payload: title, body composition, color, url, timestamp', () => {
  const n = run(
    JSON.stringify({
      content: 'Deploy finished',
      username: 'CI Bot',
      avatar_url: 'https://example.com/a.png',
      embeds: [
        {
          title: 'Build #42',
          description: 'All green',
          url: 'https://ci.example.com/42',
          color: 3066993,
          fields: [{ name: 'Branch', value: 'main' }, { name: 'Time', value: '3m' }],
          footer: { text: 'ci.example.com' },
          author: { name: 'ci' },
          timestamp: '2026-01-02T03:04:05.000Z',
        },
      ],
    }),
    { ct: 'application/json' },
  )
  assert.equal(n.source, 'discord')
  assert.equal(n.title, 'Build #42')
  assert.equal(n.body, 'Deploy finished\n\nAll green\n\nBranch: main\nTime: 3m\n\nci.example.com')
  assert.equal(n.color, '#2ecc71')
  assert.equal(n.url, 'https://ci.example.com/42')
  assert.equal(n.priority, 3)
  assert.equal(n.publishedAt?.toISOString(), '2026-01-02T03:04:05.000Z')
  assert.equal(n.empty, false)
})

test('discord title falls back to username, then feed name', () => {
  assert.equal(run('{"content":"hi","username":"Bot"}').title, 'Bot')
  assert.equal(run('{"content":"hi"}', { feed: 'Alerts' }).title, 'Alerts')
})

test('discord @everyone / @here bump priority to 4 unless explicit', () => {
  assert.equal(run('{"content":"@everyone look"}').priority, 4)
  assert.equal(run('{"embeds":[{"description":"ping @here"}]}').priority, 4)
  assert.equal(run('{"content":"@everyone look","priority":2}').priority, 2)
  assert.equal(run('{"content":"@everyone look"}', { query: 'priority=1' }).priority, 1)
  assert.equal(run('{"content":"plain"}').priority, 3)
})

test('generic json: title/message/url/priority/tags/color aliases', () => {
  const n = run(
    JSON.stringify({ subject: 'Disk full', text: '95% used', link: 'https://x.test/d', priority: 'urgent', tags: ['warn', 'disk'], color: '#ff8800' }),
    { ct: 'application/json' },
  )
  assert.equal(n.source, 'json')
  assert.equal(n.title, 'Disk full')
  assert.equal(n.body, '95% used\n\nTags: warn, disk')
  assert.equal(n.url, 'https://x.test/d')
  assert.equal(n.priority, 5)
  assert.equal(n.color, '#ff8800')
})

test('generic json: click alias, default title, string tags', () => {
  const n = run('{"body":"hello","click":"https://c.test","tags":"a, b"}', { feed: 'Hooks' })
  assert.equal(n.title, 'Hooks')
  assert.equal(n.url, 'https://c.test/') // stored as normalized u.href
  assert.equal(n.body, 'hello\n\nTags: a, b')
})

test('non-http urls are dropped', () => {
  assert.equal(run('{"title":"t","message":"m","url":"javascript:alert(1)"}').url, null)
})

test('unknown json shape is pretty-printed', () => {
  const n = run('{"foo":{"bar":1},"n":[1,2]}', { ct: 'application/json', feed: 'F' })
  assert.equal(n.source, 'json')
  assert.equal(n.title, 'F')
  assert.equal(n.body, JSON.stringify({ foo: { bar: 1 }, n: [1, 2] }, null, 2))
  const arr = run('[1,2,3]')
  assert.equal(arr.body, JSON.stringify([1, 2, 3], null, 2))
})

test('ntfy-style plain text with headers', () => {
  const n = run('Backup complete', {
    headers: { Title: 'Backup', Priority: 'high', Tags: 'floppy_disk,ok', Click: 'https://b.test/r' },
  })
  assert.equal(n.source, 'ntfy')
  assert.equal(n.title, 'Backup')
  assert.equal(n.priority, 4)
  assert.equal(n.url, 'https://b.test/r')
  assert.equal(n.body, 'Backup complete\n\nTags: floppy_disk, ok')
})

test('ntfy X- header aliases and query params', () => {
  const a = run('x', { headers: { 'X-Title': 'T', 'X-Priority': '5' } })
  assert.equal(a.title, 'T')
  assert.equal(a.priority, 5)
  assert.equal(a.source, 'ntfy')
  const b = run('x', { query: 'title=Q&priority=min' })
  assert.equal(b.title, 'Q')
  assert.equal(b.priority, 1)
  const c = run('x', { query: 'p=2' })
  assert.equal(c.priority, 2)
})

test('plain text becomes the body; empty is flagged', () => {
  const n = run('  just some text\nline 2 ', { ct: 'text/plain', feed: 'Raw' })
  assert.equal(n.source, 'text')
  assert.equal(n.title, 'Raw')
  assert.equal(n.body, 'just some text\nline 2')
  assert.equal(n.priority, 3)
  assert.equal(run('   ').empty, true)
})

test('invalid json with json content-type falls back to text', () => {
  const n = run('{not json', { ct: 'application/json' })
  assert.equal(n.source, 'text')
  assert.equal(n.body, '{not json')
})

test('long text is truncated and raw is bounded', () => {
  const n = run('a'.repeat(60_000))
  assert.ok(n.body.length <= 20_000)
  const raw = n.raw as { text: string }
  assert.ok(raw.text.length <= 32_000)
})

test('textToHtml escapes markup and converts newlines', () => {
  assert.equal(textToHtml('<b>&\nx'), '&lt;b&gt;&amp;<br>x')
})

test('readBodyLimited enforces the 64KB limit', async () => {
  assert.equal(MAX_BODY_BYTES, 65536)
  const ok = await readBodyLimited(new Request('http://x/', { method: 'POST', body: 'a'.repeat(MAX_BODY_BYTES) }))
  assert.equal(ok.ok, true)
  const big = await readBodyLimited(new Request('http://x/', { method: 'POST', body: 'a'.repeat(MAX_BODY_BYTES + 1) }))
  assert.deepEqual(big, { ok: false, reason: 'too-large' })

  // No/forged Content-Length: the streaming counter must still trip.
  const chunk = new Uint8Array(16 * 1024)
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= 10) return c.close()
      sent++
      c.enqueue(chunk)
    },
  })
  const streamed = await readBodyLimited(
    new Request('http://x/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit),
  )
  assert.deepEqual(streamed, { ok: false, reason: 'too-large' })
  assert.ok(sent < 10, 'reader stopped early')
})

test('FixedWindowLimiter allows up to limit per window then blocks, then resets', () => {
  const l = new FixedWindowLimiter()
  const k = 'test-key'
  for (let i = 0; i < 3; i++) assert.equal(l.hit(k, 3, 1000, 0).ok, true)
  const blocked = l.hit(k, 3, 1000, 10)
  assert.equal(blocked.ok, false)
  assert.ok(blocked.retryAfterSec >= 1)
  assert.equal(l.hit(k, 3, 1000, 1001).ok, true)
})

test('FixedWindowLimiter.peek does not count and flips at the limit', () => {
  const l = new FixedWindowLimiter()
  assert.equal(l.peek('k', 2, 1000, 0).ok, true)
  assert.equal(l.size, 0, 'peek must not create a bucket')
  l.hit('k', 2, 1000, 0)
  assert.equal(l.peek('k', 2, 1000, 0).ok, true)
  l.hit('k', 2, 1000, 0)
  const p = l.peek('k', 2, 1000, 0)
  assert.equal(p.ok, false)
  assert.ok(p.retryAfterSec >= 1)
  assert.equal(l.peek('k', 2, 1000, 1000).ok, true, 'expired window')
})

test('FixedWindowLimiter evicts oldest-first instead of clearing', () => {
  const l = new FixedWindowLimiter(3)
  l.hit('a', 1, 60_000, 0)
  l.hit('b', 1, 60_000, 1)
  l.hit('c', 1, 60_000, 2)
  l.hit('d', 1, 60_000, 3) // evicts only 'a'
  assert.equal(l.size, 3)
  assert.equal(l.peek('a', 1, 60_000, 4).ok, true, 'a was evicted')
  assert.equal(l.peek('b', 1, 60_000, 4).ok, false, 'b kept its count')
  assert.equal(l.peek('d', 1, 60_000, 4).ok, false, 'd kept its count')
})

test('FixedWindowLimiter.refund returns a slot in the current window only', () => {
  const l = new FixedWindowLimiter()
  l.hit('k', 2, 1000, 0)
  l.hit('k', 2, 1000, 0)
  assert.equal(l.peek('k', 2, 1000, 0).ok, false)
  l.refund('k', 1000, 0)
  assert.equal(l.peek('k', 2, 1000, 0).ok, true, 'slot returned')
  l.refund('k', 1000, 0)
  l.refund('k', 1000, 0) // never below zero
  assert.equal(l.hit('k', 2, 1000, 0).ok, true)
  assert.equal(l.hit('k', 2, 1000, 0).ok, true)
  assert.equal(l.hit('k', 2, 1000, 0).ok, false)
  l.refund('missing', 1000, 0)
  assert.equal(l.size, 1, 'refund never creates a bucket')
  l.refund('k', 1000, 5000) // stale window: no-op
  assert.equal(l.peek('k', 2, 1000, 500).ok, false)
})

// ── normalizer robustness ───────────────────────────────────────────────────

test('safeUrl: http(s) only, normalized href, rejects controls/whitespace/junk', () => {
  assert.equal(safeUrl('https://Example.COM/a b'), null, 'inner space')
  assert.equal(safeUrl('https://example.com/a\tb'), null, 'tab')
  assert.equal(safeUrl('https://example.com/a\nb'), null, 'newline')
  assert.equal(safeUrl('https://exa\u0000mple.com/'), null, 'NUL')
  assert.equal(safeUrl('https://example.com/\u0085'), null, 'C1 control')
  assert.equal(safeUrl('javascript:alert(1)'), null)
  assert.equal(safeUrl('data:text/html,hi'), null)
  assert.equal(safeUrl('ftp://example.com/'), null)
  assert.equal(safeUrl('http://'), null)
  assert.equal(safeUrl('not a url'), null)
  assert.equal(safeUrl('https://' + 'a'.repeat(2100) + '.com'), null, 'too long')
  assert.equal(safeUrl('  https://Example.COM  '), 'https://example.com/')
  assert.equal(safeUrl('HTTP://example.com/p?q=1#f'), 'http://example.com/p?q=1#f')
  assert.equal(safeUrl('https://example.com/é'), 'https://example.com/%C3%A9')
  // Flows through normalizeHook too.
  assert.equal(run('{"title":"t","url":"https://x.test/a b"}').url, null)
  assert.equal(run('{"title":"t","url":"https://X.test"}').url, 'https://x.test/')
})

test('parseDate: rejects out-of-range years, clamps far-future to now', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z')
  assert.equal(parseDate('2026-01-02T03:04:05.000Z', now)?.toISOString(), '2026-01-02T03:04:05.000Z')
  assert.equal(parseDate('0000-01-01T00:00:00Z', now), null, 'year 0')
  assert.equal(parseDate('-000001-01-01T00:00:00Z', now), null, 'negative year')
  assert.equal(parseDate('+010000-01-01T00:00:00Z', now), null, 'year 10000')
  assert.equal(parseDate('garbage', now), null)
  assert.equal(parseDate(12345, now), null)
  // Within 5 min tolerance: kept as-is.
  const soon = new Date(now + 4 * 60_000).toISOString()
  assert.equal(parseDate(soon, now)?.toISOString(), soon)
  // Beyond tolerance: clamped to now.
  assert.equal(parseDate('2030-01-01T00:00:00Z', now)?.getTime(), now)
  assert.equal(parseDate('9999-12-31T00:00:00Z', now)?.getTime(), now)
  // Through the Discord path.
  const n = normalizeHook({
    body: '{"embeds":[{"title":"x","timestamp":"2099-01-01T00:00:00Z"}]}',
    contentType: 'application/json',
    headers: new Headers(),
    query: new URLSearchParams(),
    feedName: 'F',
    now,
  })
  assert.equal(n.publishedAt?.getTime(), now)
})

test('deeply nested JSON falls back to clipped text without throwing', () => {
  assert.equal(exceedsDepth({ a: { b: 1 } }, 2), false)
  assert.equal(exceedsDepth({ a: { b: {} } }, 2), true)
  assert.equal(exceedsDepth('x'), false)

  const deep = '['.repeat(20_000) + ']'.repeat(20_000)
  const n = run(deep, { ct: 'application/json', feed: 'F' })
  assert.equal(n.source, 'json')
  assert.equal(n.body, deep.slice(0, 19_999) + '…')
  const raw = n.raw as { text: string; truncated: string }
  assert.equal(raw.truncated, 'depth')
  assert.ok(raw.text.length <= 32_000)
  assert.doesNotThrow(() => JSON.stringify(n.raw))

  // Discord payload with a deep junk field: fields still parsed, raw is text.
  let junk = '1'
  for (let i = 0; i < MAX_JSON_DEPTH + 5; i++) junk = `{"x":${junk}}`
  const d = run(`{"content":"hello","junk":${junk}}`)
  assert.equal(d.source, 'discord')
  assert.equal(d.body, 'hello')
  assert.equal((d.raw as { truncated: string }).truncated, 'depth')

  // Exactly at the limit is kept as structured JSON.
  let ok = '1'
  for (let i = 0; i < MAX_JSON_DEPTH; i++) ok = `[${ok}]`
  assert.ok(Array.isArray(run(ok).raw))
})

test('raw is sanitized: NUL stripped and lone surrogates replaced (keys too)', () => {
  const body = '{"title":"t","message":"a\\u0000b\\ud800c","\\udc00k\\u0000":["\\ud83d\\ude00","\\ud83d"]}'
  const n = run(body, { ct: 'application/json' })
  const raw = n.raw as Record<string, unknown>
  assert.equal(raw.message, 'ab�c')
  assert.deepEqual(raw['�k'], ['\u{1F600}', '�'])
  const s = JSON.stringify(raw)
  assert.ok(!/\\u0000/.test(s), 'no NUL escapes')
  assert.ok(!/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(s), 'no lone high surrogates')
  assert.ok(!/(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i.test(s), 'no lone low surrogates')
  // Text fields too.
  assert.equal(n.body, 'ab�c')
  // Plain-text raw path.
  const t = run('x\u0000y\ud800')
  assert.equal((t.raw as { text: string }).text, 'xy�')
  // Direct.
  assert.deepEqual(sanitizeJson({ a: ['\u0000', 1, null, true] }), { a: ['', 1, null, true] })
})

test('sanitizeJson keeps a "__proto__" key as data and never touches the prototype', () => {
  const parsed = JSON.parse('{"__proto__":{"polluted":"yes"},"a":{"__proto__":[1]}}') as unknown
  const out = sanitizeJson(parsed) as Record<string, unknown>
  assert.ok(Object.prototype.hasOwnProperty.call(out, '__proto__'), 'own data property kept')
  assert.equal(Object.getPrototypeOf(out), Object.prototype, 'prototype unchanged')
  assert.equal((out as { polluted?: unknown }).polluted, undefined)
  assert.equal(({} as { polluted?: unknown }).polluted, undefined, 'no global pollution')
  assert.equal(JSON.stringify(out), '{"__proto__":{"polluted":"yes"},"a":{"__proto__":[1]}}')
  // Through normalizeHook's raw column too.
  const n = run('{"title":"t","__proto__":{"x":1}}', { ct: 'application/json' })
  assert.equal(JSON.stringify(n.raw), '{"title":"t","__proto__":{"x":1}}')
})

test('truncated raw preview never ends in a split surrogate pair', () => {
  // '{"title":"t","message":"' is 24 chars, so with 31,975 filler chars the
  // first emoji starts at index 31,999 and the 32,000-char cut splits it.
  const filler = 'a'.repeat(31_975)
  const n = run(JSON.stringify({ title: 't', message: filler + '\u{1F600}'.repeat(10) }))
  const raw = n.raw as { truncated: boolean; preview: string }
  assert.equal(raw.truncated, true)
  assert.ok(!/[\uD800-\uDBFF]$/.test(raw.preview))
  assert.ok(raw.preview.endsWith('�'), 'the cut really did split a pair')
})
