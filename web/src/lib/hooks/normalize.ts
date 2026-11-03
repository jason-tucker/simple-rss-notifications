/**
 * Webhook payload normalizer. Pure (no DB / no server-only) so it is unit
 * testable. Turns Discord-style, generic JSON, ntfy-style or plain-text
 * requests into one shape that maps onto a feed_items row.
 */

export const MAX_BODY_BYTES = 64 * 1024
const MAX_TITLE_CHARS = 250
const MAX_BODY_CHARS = 20_000
const MAX_URL_CHARS = 2048
const MAX_RAW_CHARS = 32_000

export type HookSource = 'discord' | 'json' | 'text' | 'ntfy'

export interface HookInput {
  /** Raw request body as text (already size-limited). */
  body: string
  contentType?: string | null
  headers: { get(name: string): string | null }
  query: URLSearchParams
  feedName: string
  /** Clock override for tests (ms since epoch). */
  now?: number
}

export interface NormalizedHook {
  title: string
  body: string
  url: string | null
  /** 1..5 */
  priority: number
  /** '#rrggbb' or null */
  color: string | null
  source: HookSource
  publishedAt: Date | null
  /** Truncated original payload for the feed_items.raw jsonb column. */
  raw: unknown
  /** True when the request carried no usable content at all. */
  empty: boolean
}

// ── helpers ─────────────────────────────────────────────────────────────────

function clip(s: string, max: number): string {
  const clean = wellFormed(s)
  // Re-check after slicing: the cut may split a surrogate pair.
  return clean.length > max ? wellFormed(clean.slice(0, max - 1)) + '…' : clean
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Primitive → trimmed string; anything else → ''. */
function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

function firstStr(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const s = str(o[k])
    if (s) return s
  }
  return ''
}

/**
 * http(s) only, parsed by WHATWG URL and stored normalized (u.href). Inputs
 * with control characters or inner whitespace are rejected outright rather
 * than silently stripped by the URL parser.
 */
export function safeUrl(v: string): string | null {
  const s = v.trim()
  if (!s || s.length > MAX_URL_CHARS) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\s]/.test(s)) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!u.hostname || u.href.length > MAX_URL_CHARS) return null
  return u.href
}

const NAMED_PRIORITY: Record<string, number> = {
  min: 1, low: 2, default: 3, normal: 3, high: 4, urgent: 5, max: 5,
}

/** Number (1..5, clamped) or min/low/default/high/urgent/max → 1..5, else undefined. */
export function parsePriority(v: unknown): number | undefined {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? Math.min(5, Math.max(1, Math.round(v))) : undefined
  }
  if (typeof v !== 'string') return undefined
  const s = v.trim().toLowerCase()
  if (!s) return undefined
  if (/^-?\d+(\.\d+)?$/.test(s)) return parsePriority(Number(s))
  return NAMED_PRIORITY[s]
}

/** Discord int, '#rgb', '#rrggbb' or 'rrggbb' → '#rrggbb'. */
export function parseColor(v: unknown): string | null {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffff) return null
    return '#' + v.toString(16).padStart(6, '0')
  }
  if (typeof v !== 'string') return null
  const s = v.trim()
  let m = /^#?([0-9a-f]{6})$/i.exec(s)
  if (m) return '#' + m[1]!.toLowerCase()
  m = /^#?([0-9a-f]{3})$/i.exec(s)
  if (m) return '#' + m[1]!.toLowerCase().split('').map((c) => c + c).join('')
  if (/^\d+$/.test(s)) return parseColor(Number(s))
  return null
}

function parseTags(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map(str) : typeof v === 'string' ? v.split(',') : []
  return list.map((t) => t.trim()).filter(Boolean).slice(0, 20).map((t) => clip(t, 50))
}

const FUTURE_TOLERANCE_MS = 5 * 60_000

/**
 * ISO-ish string → Date. Rejects years outside 1..9999; a timestamp more
 * than 5 minutes in the future is clamped to `now` (sender clock skew or a
 * deliberately future date must not pin an item to the top of the list).
 */
export function parseDate(v: unknown, now: number = Date.now()): Date | null {
  if (typeof v !== 'string' || !v) return null
  const d = new Date(v)
  const t = d.getTime()
  if (Number.isNaN(t)) return null
  const y = d.getUTCFullYear()
  if (y < 1 || y > 9999) return null
  if (t > now + FUTURE_TOLERANCE_MS) return new Date(now)
  return d
}

/** Escape plain text into the HTML the dispatcher expects in feed_items.summary. */
export function textToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '<br>')
}

/** Max JSON nesting kept for stringify / jsonb (deeper payloads fall back to text). */
export const MAX_JSON_DEPTH = 32

/** Iterative (no recursion) check: does `v` nest objects/arrays deeper than `max`? */
export function exceedsDepth(v: unknown, max: number = MAX_JSON_DEPTH): boolean {
  const stack: Array<[unknown, number]> = [[v, 1]]
  while (stack.length) {
    const [x, d] = stack.pop()!
    if (typeof x !== 'object' || x === null) continue
    if (d > max) return true
    for (const c of Array.isArray(x) ? x : Object.values(x)) {
      if (typeof c === 'object' && c !== null) stack.push([c, d + 1])
    }
  }
  return false
}

// Unpaired surrogate halves (not representable in UTF-8 / rejected by jsonb).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** Strip U+0000 and replace lone surrogates with U+FFFD. */
export function wellFormed(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000/g, '').replace(LONE_SURROGATE, '�')
}

/**
 * Make a parsed JSON value safe for a Postgres jsonb column: every string
 * (keys included) is passed through wellFormed(). Only called on values
 * already known to be within MAX_JSON_DEPTH, so recursion is bounded.
 */
export function sanitizeJson(v: unknown): unknown {
  if (typeof v === 'string') return wellFormed(v)
  if (Array.isArray(v)) return v.map(sanitizeJson)
  if (isObj(v)) {
    // defineProperty, not `out[k] = x`: a "__proto__" key from JSON.parse must
    // stay an own data property (plain assignment would set the prototype and
    // silently drop the key).
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      Object.defineProperty(out, wellFormed(k), { value: sanitizeJson(x), enumerable: true, writable: true, configurable: true })
    }
    return out
  }
  return v
}

function buildRaw(parsed: unknown, text: string): unknown {
  if (parsed === undefined || exceedsDepth(parsed)) {
    const raw: Record<string, unknown> = { text: wellFormed(clip(text, MAX_RAW_CHARS)) }
    if (parsed !== undefined) raw.truncated = 'depth'
    return raw
  }
  const clean = sanitizeJson(parsed)
  const s = JSON.stringify(clean)
  if (s.length <= MAX_RAW_CHARS) return clean
  return { truncated: true, preview: wellFormed(s.slice(0, MAX_RAW_CHARS)) }
}

function tryParseJson(body: string, contentType: string | null | undefined): unknown {
  const t = body.trim()
  const looksJson = /json/i.test(contentType ?? '') || t.startsWith('{') || t.startsWith('[')
  if (!looksJson || !t) return undefined
  try {
    return JSON.parse(t) as unknown
  } catch {
    return undefined
  }
}

// ── ntfy-style header / query overrides ────────────────────────────────────

interface Meta {
  title: string
  priority: number | undefined
  tags: string[]
  click: string
  present: boolean
}

function readMeta(h: HookInput['headers'], q: URLSearchParams): Meta {
  const pick = (headers: string[], params: string[]): string => {
    for (const n of headers) {
      const v = h.get(n)
      if (v && v.trim()) return v.trim()
    }
    for (const n of params) {
      const v = q.get(n)
      if (v && v.trim()) return v.trim()
    }
    return ''
  }
  const title = pick(['title', 'x-title'], ['title'])
  const prio = pick(['priority', 'x-priority'], ['priority', 'p'])
  const tags = pick(['tags', 'x-tags'], ['tags'])
  const click = pick(['click', 'x-click'], ['click'])
  return {
    title,
    priority: parsePriority(prio),
    tags: parseTags(tags),
    click,
    present: Boolean(title || prio || tags || click),
  }
}

// ── Discord ─────────────────────────────────────────────────────────────────

const GENERIC_KEYS = [
  'title', 'subject', 'message', 'body', 'text', 'description',
  'url', 'link', 'click', 'priority', 'tags', 'color',
]

function isDiscord(o: Record<string, unknown>): boolean {
  return (
    Array.isArray(o.embeds) ||
    typeof o.content === 'string' ||
    typeof o.username === 'string' ||
    typeof o.avatar_url === 'string'
  )
}

function fromDiscord(
  o: Record<string, unknown>,
  meta: Meta,
  feedName: string,
  rawBody: string,
  now: number,
): NormalizedHook {
  const embeds = (Array.isArray(o.embeds) ? o.embeds : []).filter(isObj).slice(0, 10)
  const content = str(o.content)
  const parts: string[] = []
  if (content) parts.push(content)

  embeds.forEach((e, i) => {
    if (i > 0) {
      const t = str(e.title)
      if (t) parts.push(t)
    }
    const desc = str(e.description)
    if (desc) parts.push(desc)
    const fields = (Array.isArray(e.fields) ? e.fields : [])
      .filter(isObj)
      .map((f) => {
        const name = str(f.name)
        const value = str(f.value)
        return name || value ? `${name}: ${value}` : ''
      })
      .filter(Boolean)
    if (fields.length) parts.push(fields.join('\n'))
    const footer = isObj(e.footer) ? str(e.footer.text) : ''
    if (footer) parts.push(footer)
  })

  const first = embeds[0]
  const embedTitle = first ? str(first.title) : ''
  const username = str(o.username)
  const title = clip(embedTitle || username || feedName, MAX_TITLE_CHARS)
  const body = clip(parts.join('\n\n'), MAX_BODY_CHARS)

  const mention = /@everyone|@here/.test(
    [content, ...embeds.flatMap((e) => [str(e.title), str(e.description)])].join('\n'),
  )
  const explicit = parsePriority(o.priority) ?? meta.priority

  return {
    title,
    body,
    url: first ? safeUrl(str(first.url)) : null,
    priority: explicit ?? (mention ? 4 : 3),
    color: first ? parseColor(first.color) : null,
    source: 'discord',
    publishedAt: first ? parseDate(first.timestamp, now) : null,
    raw: buildRaw(o, rawBody),
    empty: !body && !embedTitle && !username,
  }
}

// ── public entry ────────────────────────────────────────────────────────────

export function normalizeHook(input: HookInput): NormalizedHook {
  const meta = readMeta(input.headers, input.query)
  const parsed = tryParseJson(input.body, input.contentType)
  const feedName = input.feedName

  if (isObj(parsed)) {
    if (isDiscord(parsed)) return fromDiscord(parsed, meta, feedName, input.body, input.now ?? Date.now())

    if (GENERIC_KEYS.some((k) => k in parsed)) {
      const title = firstStr(parsed, ['title', 'subject']) || meta.title
      let body = firstStr(parsed, ['message', 'body', 'text', 'description'])
      const tags = parsed.tags !== undefined ? parseTags(parsed.tags) : meta.tags
      if (tags.length) body = (body ? body + '\n\n' : '') + `Tags: ${tags.join(', ')}`
      const url = safeUrl(firstStr(parsed, ['url', 'link', 'click']) || meta.click)
      return {
        title: clip(title || feedName, MAX_TITLE_CHARS),
        body: clip(body, MAX_BODY_CHARS),
        url,
        priority: parsePriority(parsed.priority) ?? meta.priority ?? 3,
        color: parseColor(parsed.color),
        source: 'json',
        publishedAt: null,
        raw: buildRaw(parsed, input.body),
        empty: !title && !body,
      }
    }
  }

  if (parsed !== undefined) {
    // Valid JSON of an unknown shape → pretty-print it (too deep → raw text).
    const pretty = exceedsDepth(parsed) ? input.body.trim() : (JSON.stringify(parsed, null, 2) ?? '')
    return {
      title: clip(meta.title || feedName, MAX_TITLE_CHARS),
      body: clip(pretty, MAX_BODY_CHARS),
      url: safeUrl(meta.click),
      priority: meta.priority ?? 3,
      color: null,
      source: 'json',
      publishedAt: null,
      raw: buildRaw(parsed, input.body),
      empty: false,
    }
  }

  // Plain text (optionally ntfy-flavoured via headers / query params).
  let body = input.body.trim()
  if (meta.tags.length) body = (body ? body + '\n\n' : '') + `Tags: ${meta.tags.join(', ')}`
  return {
    title: clip(meta.title || feedName, MAX_TITLE_CHARS),
    body: clip(body, MAX_BODY_CHARS),
    url: safeUrl(meta.click),
    priority: meta.priority ?? 3,
    color: null,
    source: meta.present ? 'ntfy' : 'text',
    publishedAt: null,
    raw: buildRaw(undefined, input.body),
    empty: !body && !meta.title,
  }
}

// ── bounded body reader ─────────────────────────────────────────────────────

export type BodyResult = { ok: true; text: string } | { ok: false; reason: 'too-large' }

/** Read a request body, aborting as soon as it exceeds `max` bytes. */
export async function readBodyLimited(req: Request, max: number = MAX_BODY_BYTES): Promise<BodyResult> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) return { ok: false, reason: 'too-large' }
  if (!req.body) return { ok: true, text: '' }

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return { ok: false, reason: 'too-large' }
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  return { ok: true, text: new TextDecoder('utf-8').decode(buf) }
}
