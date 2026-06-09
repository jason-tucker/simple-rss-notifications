import 'server-only'
import { safeFetch, SsrfBlockedError } from '@/lib/ssrf'

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

export async function fetchFeed(url: string, opts: { etag?: string | null; lastModified?: string | null } = {}): Promise<FetchResult> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    // Accept-Encoding intentionally omitted: safeFetch uses Node's http(s)
    // layer which does not transparently decompress, so we let the server
    // send identity. (Most feeds are small and the 5 MiB cap is on raw bytes.)
    Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
  }
  if (opts.etag) headers['If-None-Match'] = opts.etag
  if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified

  try {
    // safeFetch resolves once, pins the connection to a validated IP, and
    // re-validates every redirect target before following — defeating DNS
    // rebinding and redirect-based SSRF.
    const res = await safeFetch(url, {
      method: 'GET',
      headers,
      timeoutMs: FETCH_TIMEOUT_MS,
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
    if (err instanceof SsrfBlockedError) {
      return { kind: 'error', error: err.message, code: 'ssrf-blocked' }
    }
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
