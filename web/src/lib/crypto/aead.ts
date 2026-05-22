import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from '@/lib/env'

/**
 * AES-256-GCM authenticated encryption for at-rest secrets (SMTP password,
 * Resend API key, ntfy bearer token, future IMAP credentials, etc.).
 *
 * Storage layout — every encrypted field lives as four columns:
 *   <field>_ciphertext  bytea NOT NULL
 *   <field>_iv          bytea NOT NULL
 *   <field>_tag         bytea NOT NULL
 *   <field>_key_version int   NOT NULL DEFAULT 1
 *
 * The key_version column lets us roll APP_ENCRYPTION_KEY without re-encrypting
 * every row in one step — old rows decrypt with the old key (version=1), new
 * rows are written under the new key (version=2 once we add it). For PR4
 * only one key exists.
 *
 * IV is 12 bytes per row (GCM standard). Tag is 16 bytes. Both are produced
 * by node:crypto and stored verbatim.
 */

const KEY_VERSION = 1
const IV_LEN = 12 // GCM standard
const TAG_LEN = 16

function getKey(version: number): Buffer {
  // Today there's exactly one key. A future rotation will add a lookup map
  // (version → env var name) and a CURRENT_KEY_VERSION constant. Until
  // then, anything other than version 1 is corrupt data.
  if (version !== KEY_VERSION) {
    throw new Error(`unknown key_version=${version}`)
  }
  return Buffer.from(env.APP_ENCRYPTION_KEY, 'hex')
}

export interface EncryptedField {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
  keyVersion: number
}

export function encrypt(plaintext: string): EncryptedField {
  const key = getKey(KEY_VERSION)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { ciphertext, iv, tag, keyVersion: KEY_VERSION }
}

export function decrypt(field: EncryptedField): string {
  const key = getKey(field.keyVersion)
  if (field.iv.length !== IV_LEN) throw new Error(`bad iv length ${field.iv.length}`)
  if (field.tag.length !== TAG_LEN) throw new Error(`bad tag length ${field.tag.length}`)
  const decipher = createDecipheriv('aes-256-gcm', key, field.iv)
  decipher.setAuthTag(field.tag)
  return Buffer.concat([decipher.update(field.ciphertext), decipher.final()]).toString('utf8')
}

export const CURRENT_KEY_VERSION = KEY_VERSION
