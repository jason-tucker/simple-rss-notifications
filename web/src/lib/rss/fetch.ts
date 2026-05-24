import 'server-only'
import { checkSafeOutboundUrl } from '@/lib/ssrf'

/**
 * Conditional GET an RSS feed. Returns one of:
 *   { kind: 'not-modified' }       304 — feed unchanged, no parse needed
 *   { kind: 'ok', body, etag,
 *                last_modified }   200 — body is the response text
 *   { kind: 'error', error, code } network/HTTP/SSRF/timeout failure
 *
 * Sends If-None-Match / If-Modified-Since when the caller has values from
 * the previous fetch. Caps body size at 5 MiB. 20-second timeout end to end.
 */

const MAX_BODY_BYTES = 5 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000
const UA = 'simple-rss-notifications/0.5 (+https://github.com/jason-tucker/simple-rss-notifications)'

export type FetchResult =
  | { kind: 'not-modified' }
  | { kind: 'ok'; body: string; etag: string | null; lastModified: string | null }
  | { kind: 'error'; error: string; code: string }

export async function fetchFeed(url: string, opts: { etag?: string | null; lastModified?: string | null; cookie?: string | null } = {}): Promise<FetchResult> {
  const ssrf = await checkSafeOutboundUrl(url)
  if (ssrf) return { kind: 'error', error: ssrf, code: 'ssrf-blocked' }

  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    'Accept-Encoding': 'gzip, deflate',
  }
  if (opts.etag) headers['If-None-Match'] = opts.etag
  if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified
  // Authenticated feeds (XenForo aggregator, paid news, etc.) need a session
  // cookie. The API write boundary (POST/PATCH /api/feeds) already rejects
  // cookies containing C0/C1 controls, DEL, and U+2028/U+2029 with a clear
  // 400 error, so anything reaching here should already be clean. Strip
  // defensively as belt-and-braces (matching the boundary range): an
  // attacker who somehow seeded a bad value into the DB still can't smuggle
  // headers, and undici's runtime header validation would throw otherwise —
  // silent strip is better than a poll-time crash.
  if (opts.cookie) headers['Cookie'] = opts.cookie.replace(/[\x00-\x1F\x7F-\x9F  ]/gu, '').trim()

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (res.status === 304) return { kind: 'not-modified' }
    if (!res.ok) {
      return { kind: 'error', error: `HTTP ${res.status}`, code: `http-${res.status}` }
    }

    // Cap body size to avoid memory blowups on a hostile feed.
    const reader = res.body?.getReader()
    if (!reader) {
      return { kind: 'error', error: 'no response body', code: 'no-body' }
    }
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        return { kind: 'error', error: `body exceeds ${MAX_BODY_BYTES} bytes`, code: 'body-too-large' }
      }
      chunks.push(value)
    }
    const body = new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))))

    return {
      kind: 'ok',
      body,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { kind: 'error', error: 'fetch timed out', code: 'timeout' }
    }
    return {
      kind: 'error',
      error: err instanceof Error ? err.message : String(err),
      code: 'fetch-failed',
    }
  }
}
