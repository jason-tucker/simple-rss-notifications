/**
 * Shared URL-safety allowlist helpers.
 *
 * NOTE: this module is intentionally NOT `server-only`. It is imported by
 * both server code (`lib/rss/format.ts`, `lib/rss/parse.ts`) and a client
 * React component (`components/ActivityList.tsx`). Keep it dependency-free
 * and side-effect-free so it bundles cleanly into the client.
 */

/**
 * Lower-case the URL and strip any embedded ASCII control characters
 * (incl. NUL, tab, newline, carriage return) that browsers tolerate inside
 * a scheme -- e.g. `java\tscript:` or `java\nscript:` -- plus surrounding
 * whitespace, so tricks like " javascript:" can't defeat a naive
 * `startsWith` scheme check.
 */
function normalizeForSchemeCheck(url: string): string {
  // Strip all ASCII control chars (0x00-0x1F, 0x7F) anywhere in the string,
  // then trim surrounding whitespace, then lower-case for the scheme compare.
  // eslint-disable-next-line no-control-regex
  return url.replace(/[\x00-\x1f\x7f]/g, '').trim().toLowerCase()
}

/**
 * Allowlist for URLs we're willing to emit into sanitized HTML
 * (`href`/`src`). Permits:
 *   - http:// and https://
 *   - mailto:
 *   - relative URLs (no scheme -- harmless without a base)
 *
 * Everything else (javascript:, data:, vbscript:, file:, etc.) is rejected.
 */
export function isSafeUrl(url: string): boolean {
  const u = normalizeForSchemeCheck(url)
  if (u.startsWith('http://') || u.startsWith('https://') || u.startsWith('mailto:')) return true
  // Relative URLs (no scheme) -- leave as-is; they're harmless without a base.
  if (!u.includes(':')) return true
  return false
}

/**
 * Stricter allowlist for outbound clickable links rendered in the UI
 * (e.g. the "Source" anchor in ActivityList). Only http(s) -- no mailto,
 * no relative -- because a feed-controlled "external source" link should be
 * an absolute web URL, and we never want a feed to coerce a relative link
 * that resolves against our own origin.
 */
export function isSafeHttpUrl(url: string): boolean {
  const u = normalizeForSchemeCheck(url)
  return u.startsWith('http://') || u.startsWith('https://')
}
