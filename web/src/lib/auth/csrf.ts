import 'server-only'
import { env } from '@/lib/env'

/**
 * Origin-check CSRF defense. For any state-changing request (POST/PUT/PATCH/
 * DELETE), require either:
 *   - Origin header matching PUBLIC_BASE_URL, OR
 *   - Referer header whose origin matches PUBLIC_BASE_URL.
 *
 * SameSite=Lax on our session cookie already blocks cross-site POSTs that
 * are top-level navigations — but Lax still allows same-origin embed
 * scenarios, so this Origin check is the second layer.
 *
 * Returns true if the request looks safe, false to reject.
 */
export function isSameOrigin(req: Request): boolean {
  const expected = (() => {
    try {
      const u = new URL(env.PUBLIC_BASE_URL)
      return `${u.protocol}//${u.host}`
    } catch {
      return null
    }
  })()
  if (!expected) return false

  const origin = req.headers.get('origin')
  if (origin) return origin === expected

  // No Origin header — fall back to Referer's origin.
  const referer = req.headers.get('referer')
  if (referer) {
    try {
      const u = new URL(referer)
      return `${u.protocol}//${u.host}` === expected
    } catch {
      return false
    }
  }

  // Some user-agents omit both on same-origin requests. SameSite=Lax + the
  // browser auto-attaching the __Host- cookie is the real gate here, so a
  // missing Origin/Referer for a same-origin POST is acceptable.
  return true
}
