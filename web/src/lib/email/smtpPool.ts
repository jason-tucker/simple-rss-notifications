/**
 * Keyed cache for pooled SMTP transports (or any closable resource).
 *
 * Why: creating a nodemailer transport per email costs a full
 * TCP + TLS + EHLO + AUTH handshake every time. Caching a pooled
 * transport per sink reuses the connection across sends.
 *
 * Invalidation rules:
 *   - fingerprint mismatch (host/port/creds edited) → close old, miss
 *   - explicit drop() after connection-level errors → fresh next time
 *   - idle sweep: entries unused for idleMs get closed on the next access
 *
 * Deliberately dependency-free and side-effect-free so it unit-tests
 * without nodemailer.
 */
export class KeyedTransportCache<T> {
  private entries = new Map<string, { value: T; fingerprint: string; lastUsedAt: number }>()

  constructor(
    private closeFn: (value: T) => void,
    private idleMs: number,
  ) {}

  /**
   * Cached value for `key` if its fingerprint still matches; otherwise the
   * stale entry is closed and null returns. Also sweeps idle entries so no
   * timer is needed.
   */
  get(key: string, fingerprint: string, now: number = Date.now()): T | null {
    this.sweep(now)
    const e = this.entries.get(key)
    if (!e) return null
    if (e.fingerprint !== fingerprint) {
      this.drop(key)
      return null
    }
    e.lastUsedAt = now
    return e.value
  }

  set(key: string, fingerprint: string, value: T, now: number = Date.now()): void {
    this.drop(key) // close any replaced entry
    this.entries.set(key, { value, fingerprint, lastUsedAt: now })
  }

  /** Close + forget one entry (no-op when absent). */
  drop(key: string): void {
    const e = this.entries.get(key)
    if (!e) return
    this.entries.delete(key)
    try { this.closeFn(e.value) } catch { /* closing best-effort */ }
  }

  /** Close + forget entries idle longer than idleMs. */
  sweep(now: number = Date.now()): void {
    for (const [key, e] of this.entries) {
      if (now - e.lastUsedAt > this.idleMs) this.drop(key)
    }
  }

  get size(): number {
    return this.entries.size
  }
}

/**
 * Stable fingerprint over connection-identity fields — a plain serialized
 * string compared for equality, nothing more. Callers pass the credential
 * CIPHERTEXT (never plaintext): it changes on rotation, which is exactly
 * the invalidation signal we need, and AES-GCM ciphertext reveals nothing
 * without the key. Deliberately NOT hashed — this is not password storage
 * (argon2id owns that), and the string never leaves process memory.
 */
export function connectionFingerprint(parts: Array<string | number | boolean | null | undefined>): string {
  return JSON.stringify(parts)
}
