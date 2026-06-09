import 'server-only'
import { promises as dns } from 'node:dns'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { Readable, pipeline } from 'node:stream'

/**
 * SSRF guard for any outbound URL the worker/web fetches under user control —
 * RSS feeds, the user-set ntfy base URL, Discord webhook URLs, anything else
 * where the user pastes a URL we'll then go reach.
 *
 * Defends against:
 *   1. Pointing us at Docker-internal services (e.g. http://db:5432 to
 *      probe the Postgres container, or http://web:3000 to bounce a
 *      request off our own auth-less side).
 *   2. Cloud metadata services (169.254.169.254 — AWS/GCP IMDS; same
 *      address space on most clouds).
 *   3. Loopback / link-local / private RFC1918 / IPv4-mapped IPv6 /
 *      NAT64 / 6to4 / etc.
 *   4. DNS rebinding (TOCTOU): the address is resolved ONCE and the TCP
 *      connection is PINNED to that validated address — connect == check.
 *   5. Redirect-based SSRF: redirects are followed MANUALLY and every
 *      `Location` is fully re-validated (resolve + pin) before we follow.
 *
 * `checkSafeOutboundUrl` is kept for the API-route validation path (validate
 * a user-pasted URL at save time). `safeFetch` is the hardened replacement
 * for raw `fetch()` at every outbound HTTP call site.
 */

// ---------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------

function ipFamily(s: string): 4 | 6 | null {
  if (net.isIPv4(s)) return 4
  if (net.isIPv6(s)) return 6
  return null
}

/** True if the dotted-quad string is a private/reserved IPv4 address. */
function isPrivateV4(addr: string): boolean {
  const parts = addr.split('.').map((n) => parseInt(n, 10))
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  if (a === 10) return true // 10/8
  if (a === 127) return true // loopback
  if (a === 0) return true // 0/8 (this host)
  if (a === 169 && b === 254) return true // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking 198.18/15
  if (a >= 224) return true // multicast / reserved / future (224.0.0.0+)
  return false
}

/**
 * Expand an IPv6 address to its 16 bytes. Returns null if it can't be parsed
 * (caller should treat unparseable as unsafe). Handles `::` compression and
 * the embedded dotted-quad form (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`).
 */
function ipv6ToBytes(addr: string): Uint8Array | null {
  let s = addr.toLowerCase()
  // Strip a zone id (fe80::1%eth0) — irrelevant for classification.
  const pct = s.indexOf('%')
  if (pct !== -1) s = s.slice(0, pct)

  // An embedded IPv4 tail (the part after the last ':') in dotted form.
  let tailBytes: number[] | null = null
  const lastColon = s.lastIndexOf(':')
  const tail = lastColon === -1 ? '' : s.slice(lastColon + 1)
  if (tail.includes('.')) {
    if (!net.isIPv4(tail)) return null
    tailBytes = tail.split('.').map((n) => parseInt(n, 10))
    // Replace the dotted tail with two hextets so the rest parses uniformly.
    const [b0, b1, b2, b3] = tailBytes as [number, number, number, number]
    const h1 = ((b0 << 8) | b1).toString(16)
    const h2 = ((b2 << 8) | b3).toString(16)
    s = s.slice(0, lastColon + 1) + h1 + ':' + h2
  }

  const hasDoubleColon = s.includes('::')
  const [headStr, tailStr = ''] = hasDoubleColon ? s.split('::') : [s, undefined as unknown as string]

  const head = headStr === '' ? [] : headStr.split(':')
  const tailParts = !hasDoubleColon ? [] : tailStr === '' ? [] : tailStr.split(':')

  const groups: number[] = []
  const pushHextet = (h: string): boolean => {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return false
    groups.push(parseInt(h, 16))
    return true
  }

  for (const h of head) if (!pushHextet(h)) return null

  if (hasDoubleColon) {
    const tailGroups: number[] = []
    for (const h of tailParts) {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null
      tailGroups.push(parseInt(h, 16))
    }
    const fill = 8 - groups.length - tailGroups.length
    if (fill < 0) return null
    for (let i = 0; i < fill; i++) groups.push(0)
    groups.push(...tailGroups)
  }

  if (groups.length !== 8) return null

  const bytes = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i]! >> 8) & 0xff
    bytes[i * 2 + 1] = groups[i]! & 0xff
  }
  return bytes
}

function isPrivateV6(addr: string): boolean {
  const b = ipv6ToBytes(addr)
  if (!b) return true // unparseable → treat as unsafe

  // :: (unspecified) and ::1 (loopback)
  const allZeroExceptLast = b.slice(0, 15).every((x) => x === 0)
  if (allZeroExceptLast && (b[15] === 0 || b[15] === 1)) return true

  // IPv4-mapped ::ffff:0:0/96  → first 10 bytes 0, bytes[10]=0xff bytes[11]=0xff
  const firstTenZero = b.slice(0, 10).every((x) => x === 0)
  if (firstTenZero && b[10] === 0xff && b[11] === 0xff) {
    const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`
    return isPrivateV4(v4)
  }
  // Deprecated IPv4-compatible ::0.0.0.0/96 (first 12 bytes zero, non-zero tail)
  if (b.slice(0, 12).every((x) => x === 0) && (b[12]! | b[13]! | b[14]! | b[15]!) !== 0) {
    const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`
    return isPrivateV4(v4)
  }

  // NAT64 64:ff9b::/96  → 0x0064 0xff9b then 0,0,0,0,0,0,0,0
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b &&
      b.slice(4, 12).every((x) => x === 0)) {
    const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`
    return isPrivateV4(v4)
  }

  // 6to4 2002::/16 → embedded v4 in bytes 2..5
  if (b[0] === 0x20 && b[1] === 0x02) {
    const v4 = `${b[2]}.${b[3]}.${b[4]}.${b[5]}`
    return isPrivateV4(v4)
  }

  // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true
  // fc00::/7 ULA (fc00::/8 + fd00::/8)
  if ((b[0]! & 0xfe) === 0xfc) return true
  // ff00::/8 multicast
  if (b[0] === 0xff) return true

  return false
}

/**
 * Classify a literal IP address as private/reserved (true) or routable (false).
 * Exported for tests. `family` may be omitted; it's auto-detected.
 */
export function isPrivateAddress(addr: string, family?: 4 | 6): boolean {
  const fam = family ?? ipFamily(addr)
  if (fam === 4) return isPrivateV4(addr)
  if (fam === 6) return isPrivateV6(addr)
  // Not a valid IP literal → treat as unsafe.
  return true
}

// ---------------------------------------------------------------------------
// Host resolution + validation
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  /** Validated addresses to pin the connection to. */
  addresses: Array<{ address: string; family: 4 | 6 }>
}

/**
 * Resolve `host` (or accept a literal IP) and validate EVERY returned address.
 * Returns the validated addresses on success, or an error string on failure.
 * This is the single resolve step that `safeFetch` pins the connection to,
 * eliminating the resolve/connect TOCTOU window.
 */
async function resolveAndValidate(host: string): Promise<{ ok: true; target: ResolvedTarget } | { ok: false; error: string }> {
  if (!host) return { ok: false, error: 'URL has no hostname' }

  // Reject docker-internal / local style names early. Anything that does
  // resolve to a private IP is caught by the IP check below regardless.
  const lowerHost = host.toLowerCase()
  if (lowerHost === 'localhost' || lowerHost.endsWith('.localhost') || lowerHost.endsWith('.local')) {
    return { ok: false, error: `hostname '${host}' is not allowed (local)` }
  }

  const literal = ipFamily(host)
  if (literal) {
    if (isPrivateAddress(host, literal)) return { ok: false, error: `IP ${host} is private/reserved` }
    return { ok: true, target: { addresses: [{ address: host, family: literal }] } }
  }

  let records: Array<{ address: string; family: number }>
  try {
    records = await dns.lookup(host, { all: true, verbatim: true })
  } catch (err) {
    return { ok: false, error: `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (records.length === 0) return { ok: false, error: `no DNS records for ${host}` }

  const addresses: Array<{ address: string; family: 4 | 6 }> = []
  for (const r of records) {
    const fam = r.family === 4 || r.family === 6 ? r.family : null
    if (!fam) return { ok: false, error: `${host} resolved to unexpected address family` }
    if (isPrivateAddress(r.address, fam)) {
      return { ok: false, error: `${host} resolves to private/reserved address ${r.address}` }
    }
    addresses.push({ address: r.address, family: fam })
  }
  return { ok: true, target: { addresses } }
}

/**
 * Validate a user-supplied outbound URL (protocol + host). Returns null when
 * safe, or an error message string when unsafe. Used by API routes to reject
 * bad URLs at save time. Note: this is best-effort at save time — actual
 * fetches go through `safeFetch`, which re-resolves and pins, so this passing
 * does NOT by itself protect against rebinding.
 */
export async function checkSafeOutboundUrl(rawUrl: string): Promise<string | null> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return 'invalid URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `only http/https allowed (got ${url.protocol.replace(':', '')})`
  }
  const res = await resolveAndValidate(url.hostname)
  return res.ok ? null : res.error
}

/**
 * Resolve + validate a bare host (no URL). Literal IPs are checked directly.
 * Returns true when the host is private/reserved (or unresolvable), i.e. the
 * caller should refuse to connect. Used by the SMTP guard, where there's no
 * URL/HTTP layer to route through `safeFetch`.
 */
export async function isPrivateHost(host: string): Promise<boolean> {
  const res = await resolveAndValidate(host)
  return !res.ok
}

// ---------------------------------------------------------------------------
// safeFetch — pinned, redirect-revalidating HTTP client
// ---------------------------------------------------------------------------

export interface SafeFetchInit {
  method?: string
  headers?: Record<string, string>
  /** Request body. Strings are sent as-is (UTF-8). */
  body?: string
  /** End-to-end timeout in ms (per the whole request incl. redirects). */
  timeoutMs?: number
  /** Max redirect hops to follow. Default 5. */
  maxRedirects?: number
}

export interface SafeFetchResponse {
  status: number
  ok: boolean
  headers: Headers
  /** Web ReadableStream of the response body (or null if none). */
  body: ReadableStream<Uint8Array> | null
  /** Convenience: read the whole body as text (no size cap — use for small bodies). */
  text(): Promise<string>
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Error thrown when safeFetch refuses a target (initial host or a redirect). */
export class SsrfBlockedError extends Error {
  readonly code = 'ssrf-blocked'
  constructor(message: string) {
    super(message)
    this.name = 'SsrfBlockedError'
  }
}

/**
 * Hardened replacement for `fetch()` at outbound call sites.
 *
 * - Resolves the host ONCE and pins the TCP connection to a validated IP via
 *   a custom `lookup` (connect == check; defeats DNS rebinding/TOCTOU).
 * - Preserves the original Host header and TLS SNI (we pin the IP via the
 *   socket lookup, NOT by rewriting the URL to a literal IP).
 * - Follows redirects MANUALLY, re-validating every `Location` before
 *   following. Rejects redirects to private/reserved targets.
 * - Enforces an end-to-end timeout across all hops.
 */
export async function safeFetch(rawUrl: string, init: SafeFetchInit = {}): Promise<SafeFetchResponse> {
  const maxRedirects = init.maxRedirects ?? 5
  const timeoutMs = init.timeoutMs ?? 20_000

  // Absolute end-to-end deadline. Unlike socket idle timeouts, this fires
  // regardless of trickled bytes (defeats slow-loris feeds) and stays armed
  // through the body-streaming phase too — the returned stream is wired to
  // this controller so a slow body read still aborts at the deadline.
  const controller = new AbortController()
  const timer = setTimeout(() => {
    const e = new Error('fetch timed out')
    e.name = 'TimeoutError'
    controller.abort(e)
  }, timeoutMs)

  let currentUrl = rawUrl
  let method = (init.method ?? 'GET').toUpperCase()
  let body: string | undefined = init.body
  // Body is only present on the first request; per HTTP semantics we drop it
  // when a redirect downgrades the method to GET.
  let headers: Record<string, string> = { ...(init.headers ?? {}) }

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      throwIfAborted(controller.signal)

      const res = await singleRequest(currentUrl, { method, headers, body, signal: controller.signal })

      if (!REDIRECT_STATUSES.has(res.statusCode) || !res.location) {
        // Final response: hand back a stream that disarms the deadline timer
        // once the body is fully consumed (or aborted).
        return toResponse(res, () => clearTimeout(timer))
      }

      if (hop === maxRedirects) {
        // Drain and bail — too many redirects.
        res.consume()
        throw new Error('too many redirects')
      }

      // Resolve the redirect target against the current URL and re-validate.
      let nextUrl: URL
      try {
        nextUrl = new URL(res.location, currentUrl)
      } catch {
        res.consume()
        throw new Error('redirect to invalid URL')
      }
      res.consume()

      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
        throw new SsrfBlockedError(`redirect to disallowed scheme ${nextUrl.protocol.replace(':', '')}`)
      }
      const check = await resolveAndValidate(nextUrl.hostname)
      if (!check.ok) {
        throw new SsrfBlockedError(`redirect blocked: ${check.error}`)
      }

      // 301/302/303 → subsequent request becomes GET and drops the body
      // (303 always; 301/302 by near-universal convention). 307/308 preserve.
      if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET'
        body = undefined
        delete headers['content-type']
        delete headers['Content-Type']
        delete headers['content-length']
        delete headers['Content-Length']
      }
      currentUrl = nextUrl.toString()
    }

    // Unreachable: loop returns or throws.
    throw new Error('redirect handling failed')
  } catch (err) {
    clearTimeout(timer)
    // Surface the deadline as a TimeoutError rather than a raw AbortError.
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      if (reason instanceof Error && reason.name === 'TimeoutError') throw reason
    }
    throw err
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason = signal.reason
    if (reason instanceof Error) throw reason
    const e = new Error('fetch aborted')
    e.name = 'AbortError'
    throw e
  }
}

interface RawResponse {
  statusCode: number
  location: string | null
  headers: Headers
  stream: Readable
  consume(): void
}

/**
 * Perform exactly one HTTP request with the connection pinned to a freshly
 * validated address. No automatic redirect following (we handle that one
 * level up so we can re-validate each hop).
 */
async function singleRequest(
  rawUrl: string,
  opts: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
): Promise<RawResponse> {
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`only http/https allowed (got ${url.protocol.replace(':', '')})`)
  }

  const check = await resolveAndValidate(url.hostname)
  if (!check.ok) throw new SsrfBlockedError(check.error)
  const pinned = check.target.addresses

  // Custom lookup: hand the http(s) client ONLY our pre-validated address(es)
  // for this hostname, and re-assert they're not private. The client never
  // does its own DNS, so connect == check.
  const lookup: net.LookupFunction = (hostname, options, callback) => {
    const want4 = options?.family === 4
    const want6 = options?.family === 6
    const all = options?.all === true
    const usable = pinned.filter((p) => {
      if (isPrivateAddress(p.address, p.family)) return false
      if (want4) return p.family === 4
      if (want6) return p.family === 6
      return true
    })
    if (usable.length === 0) {
      callback(new Error(`no validated address for ${hostname}`), '', 0)
      return
    }
    if (all) {
      // @ts-expect-error node's overloaded LookupFunction allows the array form
      callback(null, usable.map((p) => ({ address: p.address, family: p.family })))
    } else {
      const first = usable[0]!
      callback(null, first.address, first.family)
    }
  }

  const isHttps = url.protocol === 'https:'
  const transport = isHttps ? https : http
  const bodyBuf = opts.body != null ? Buffer.from(opts.body, 'utf8') : undefined

  const reqHeaders: Record<string, string> = { ...opts.headers }
  if (bodyBuf && !hasHeader(reqHeaders, 'content-length')) {
    reqHeaders['Content-Length'] = String(bodyBuf.byteLength)
  }
  // Advertise the encodings we can transparently decode below; node's http
  // layer (unlike fetch/undici) does NOT auto-decompress, so we must do it.
  if (!hasHeader(reqHeaders, 'accept-encoding')) {
    reqHeaders['Accept-Encoding'] = 'gzip, deflate, br'
  }

  return await new Promise<RawResponse>((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname, // preserves Host header + TLS SNI
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: opts.method,
        headers: reqHeaders,
        lookup,
        signal: opts.signal, // absolute end-to-end deadline (connect + headers)
        // Defense in depth: even if a CNAME/AAAA changed, lookup only returns
        // validated IPs; servername keeps SNI correct for the real host.
        servername: isHttps ? url.hostname : undefined,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0
        const location = res.headers.location ?? null
        const headers = new Headers()
        for (const [k, v] of Object.entries(res.headers)) {
          if (v == null) continue
          if (Array.isArray(v)) for (const vv of v) headers.append(k, vv)
          else headers.set(k, v)
        }
        const stream = decodeStream(res, res.headers['content-encoding'])
        let consumed = false
        resolve({
          statusCode,
          location,
          headers,
          stream,
          consume: () => {
            if (consumed) return
            consumed = true
            res.resume() // discard body so the socket frees
            if (stream !== res) stream.destroy()
          },
        })
      },
    )

    req.on('error', (err) => reject(err))
    if (bodyBuf) req.write(bodyBuf)
    req.end()
  })
}

/**
 * Transparently decompress the response per Content-Encoding. node:http does
 * not auto-decompress, so a server honoring our Accept-Encoding would otherwise
 * hand us raw gzip bytes that fail XML/JSON parsing. Unknown encodings pass
 * through untouched. The decompressor is piped (not awaited) so the byte cap
 * in the consumer still applies to the decompressed stream.
 */
function decodeStream(res: Readable, encodingHeader: string | undefined): Readable {
  const encoding = (encodingHeader ?? '').toLowerCase().trim()
  let decoder: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null = null
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    decoder = zlib.createGunzip()
  } else if (encoding === 'deflate') {
    // Some servers send raw (headerless) deflate; createInflate tolerates both
    // zlib-wrapped and raw streams when given this option.
    decoder = zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
  } else if (encoding === 'br') {
    decoder = zlib.createBrotliDecompress()
  }
  if (!decoder) return res
  // pipeline propagates source errors/aborts to the decoder and destroys both.
  pipeline(res, decoder, () => {})
  return decoder
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase()
  return Object.keys(headers).some((k) => k.toLowerCase() === lower)
}

function toResponse(res: RawResponse, onDone: () => void): SafeFetchResponse {
  const status = res.statusCode
  // Disarm the deadline timer once the underlying node stream is finished or
  // torn down (covers normal end, caller cancel, and deadline-abort destroy).
  res.stream.once('close', onDone)
  const webStream = Readable.toWeb(res.stream) as ReadableStream<Uint8Array>
  let bodyUsed = false
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: res.headers,
    body: webStream,
    async text(): Promise<string> {
      if (bodyUsed) throw new Error('body already consumed')
      bodyUsed = true
      const chunks: Buffer[] = []
      for await (const chunk of webStream as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk))
      }
      return Buffer.concat(chunks).toString('utf8')
    },
  }
}

/**
 * Read a response body stream with a hard byte cap, returning decoded text.
 * Bytes past `maxBytes` are discarded (the stream is destroyed). Exported so
 * provider clients can read error bodies without an unbounded `.text()`.
 */
export async function readCappedText(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!stream) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (total >= maxBytes) {
        await reader.cancel().catch(() => {})
        break
      }
      const remaining = maxBytes - total
      if (value.length > remaining) {
        chunks.push(value.subarray(0, remaining))
        total += remaining
        await reader.cancel().catch(() => {})
        break
      }
      chunks.push(value)
      total += value.length
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}
