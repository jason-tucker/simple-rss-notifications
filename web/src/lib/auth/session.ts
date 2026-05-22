import 'server-only'
import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import { randomBytes } from 'node:crypto'
import { env } from '@/lib/env'

/**
 * Session cookie. JWT signed with HS512 via `jose`. Stored under the `__Host-`
 * cookie prefix so the browser refuses to send it cross-origin and refuses
 * to accept a cookie with a Domain attribute — locks it tight to this origin.
 *
 * Sliding TTL — every successful auth-gated request rolls it forward by
 * re-issuing the cookie with a fresh exp. Revocation happens server-side:
 * the JWT's `jti` is mirrored to web_sessions; deleting that row (logout,
 * "logout everywhere", password change) makes the cookie useless even
 * before it expires.
 *
 * `password_changed_at` on the user row vs `iat` in the JWT is the second
 * revocation channel — bumping password_changed_at invalidates every JWT
 * issued before that moment, including ones from other devices.
 */

const COOKIE_NAME = '__Host-session'
const TTL_SECONDS = 60 * 60 * 24 * 3 // 3 days
const ALG = 'HS512'

export interface Session {
  /** Server-side session id (jti). Mirrored into web_sessions for revocation. */
  jti: string
  /** Authenticated user id (UUID). */
  uid: string
  /** Username — denormalized so we don't need a DB hit for every page render. */
  username: string
  /** unix seconds — used to check against users.password_changed_at. */
  iat: number
  /** unix seconds — if set, sensitive ops can be performed until this time. */
  elevatedUntil?: number
}

export function newJti(): string {
  return randomBytes(24).toString('hex')
}

function key(): Uint8Array {
  return new TextEncoder().encode(env.SESSION_SECRET)
}

export async function mintSession(s: Omit<Session, 'iat'>): Promise<string> {
  return await new SignJWT({ ...s })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(key())
}

export async function verifySession(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: [ALG] })
    if (
      typeof payload.jti !== 'string' ||
      typeof payload.uid !== 'string' ||
      typeof payload.username !== 'string' ||
      typeof payload.iat !== 'number'
    ) {
      return null
    }
    const out: Session = {
      jti: payload.jti,
      uid: payload.uid,
      username: payload.username,
      iat: payload.iat,
    }
    if (typeof payload.elevatedUntil === 'number') out.elevatedUntil = payload.elevatedUntil
    return out
  } catch {
    return null
  }
}

export async function setSessionCookie(token: string): Promise<void> {
  const c = await cookies()
  c.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: TTL_SECONDS,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const c = await cookies()
  c.set(COOKIE_NAME, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
}

export async function readSessionCookie(): Promise<Session | null> {
  const c = await cookies()
  const tok = c.get(COOKIE_NAME)?.value
  if (!tok) return null
  return verifySession(tok)
}

export const SESSION_TTL_SECONDS = TTL_SECONDS
export const SESSION_COOKIE_NAME = COOKIE_NAME
