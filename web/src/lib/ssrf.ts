import 'server-only'
import { promises as dns } from 'node:dns'
import net from 'node:net'

/**
 * SSRF guard for any outbound URL the worker fetches under user control —
 * RSS feeds today, future webhook destinations, anything else where the
 * user pastes a URL we'll then go reach.
 *
 * Defends against three classes of attack:
 *   1. Pointing us at Docker-internal services (e.g. http://db:5432 to
 *      probe the Postgres container, or http://web:3000 to bounce a
 *      request off our own auth-less side).
 *   2. Cloud metadata services (169.254.169.254 — AWS/GCP IMDS; same
 *      address space on most clouds).
 *   3. Loopback / link-local / private RFC1918 / IPv4-mapped IPv6 / etc.
 *
 * Re-checks DNS on every call because a DNS resolver under attacker
 * control could return a public IP at registration time and a private IP
 * at fetch time (DNS rebinding).
 *
 * Returns null if URL is safe; an error message string if it isn't.
 * Pattern lifted from squishybot/src/services/social/poller.ts.
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

  const host = url.hostname
  if (!host) return 'URL has no hostname'

  // Reject docker-internal style names early — these don't resolve via
  // public DNS, but anything that does resolve to a docker network IP
  // would be caught by the IP check below too.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return `hostname '${host}' is not allowed (local)`
  }

  // Literal IP in the URL — check it directly without DNS.
  const literal = ipFamily(host)
  if (literal) {
    return isPrivateAddress(host, literal) ? `IP ${host} is private/reserved` : null
  }

  // DNS lookup. Resolve A + AAAA records and reject if ANY of them is
  // private — covers split-horizon DNS where a domain resolves to a
  // public address once and a private address later.
  let records: Array<{ address: string; family: number }>
  try {
    records = await dns.lookup(host, { all: true, verbatim: true })
  } catch (err) {
    return `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}`
  }
  if (records.length === 0) return `no DNS records for ${host}`

  for (const r of records) {
    const fam = r.family === 4 || r.family === 6 ? r.family : null
    if (fam && isPrivateAddress(r.address, fam)) {
      return `${host} resolves to private/reserved address ${r.address}`
    }
  }
  return null
}

function ipFamily(s: string): 4 | 6 | null {
  if (net.isIPv4(s)) return 4
  if (net.isIPv6(s)) return 6
  return null
}

function isPrivateAddress(addr: string, family: 4 | 6): boolean {
  if (family === 4) {
    const parts = addr.split('.').map((n) => parseInt(n, 10))
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true
    const [a, b] = parts as [number, number]
    if (a === 10) return true                       // 10/8
    if (a === 127) return true                      // loopback
    if (a === 0) return true                        // 0/8
    if (a === 169 && b === 254) return true         // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
    if (a === 192 && b === 168) return true         // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a >= 224) return true                       // multicast / future
    return false
  }
  // IPv6
  const lower = addr.toLowerCase()
  if (lower === '::1' || lower === '::') return true                            // loopback / unspecified
  if (lower.startsWith('fe80:') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true // fe80::/10 link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true             // fc00::/7 ULA
  if (lower.startsWith('ff')) return true                                       // ff00::/8 multicast
  // IPv4-mapped IPv6: ::ffff:a.b.c.d — recheck the embedded v4.
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length)
    if (net.isIPv4(v4)) return isPrivateAddress(v4, 4)
  }
  return false
}
