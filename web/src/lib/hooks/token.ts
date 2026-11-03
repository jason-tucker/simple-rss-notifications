import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { env } from '@/lib/env'

/** 256-bit random token, base64url (43 chars). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Cheap shape check so junk never reaches the DB. */
export function looksLikeToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32,128}$/.test(token)
}

export function hookUrl(token: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/hooks/${token}`
}
