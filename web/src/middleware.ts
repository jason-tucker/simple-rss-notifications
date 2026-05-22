import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Edge middleware. Cheap pre-flight gate:
 *   - Public paths (login + the auth API endpoints + Next assets + any
 *     plain static file like logo.png) pass through unchanged.
 *   - Everything else, if there's no session cookie at all, gets bounced
 *     to /login?next=<original-path>.
 *
 * We do NOT verify the JWT here — middleware runs on the edge runtime,
 * which can't reach Postgres for the jti / password_changed_at check.
 * That deeper validation happens server-side in the page (via
 * readSessionCookie + DB lookup) or the API route (via withAuth).
 * The cookie-presence check is just a UX redirect, not a security
 * boundary.
 */

const SESSION_COOKIE = '__Host-session'

const PUBLIC_PREFIXES = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/_next',
  '/favicon.ico',
]

/**
 * Anything matching a static-asset extension is treated as public. This
 * is what lets `/logo.png` load on `/login` (otherwise middleware
 * bounces it to /login itself, and the Next image optimizer returns 400
 * because it expects an image back but gets an HTML redirect).
 */
const STATIC_ASSET_RE = /\.(png|jpe?g|svg|gif|ico|webp|avif|css|js|map|woff2?|ttf|otf|txt|xml|webmanifest)$/i

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next()
  }
  if (STATIC_ASSET_RE.test(pathname)) {
    return NextResponse.next()
  }
  const has = req.cookies.get(SESSION_COOKIE)?.value
  if (!has) {
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
