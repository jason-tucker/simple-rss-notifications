import { hash, verify } from '@node-rs/argon2'

/**
 * Password hashing — argon2id, OWASP-recommended parameters.
 *
 * memoryCost=19 MiB, timeCost=2, parallelism=1, hashLength=32.
 * These match the OWASP 2024 minimum and the @node-rs/argon2 defaults
 * for `Algorithm.Argon2id`. Each hash takes ~50ms on this VPS, which is
 * the right ballpark — fast enough to not bottleneck login but slow
 * enough to make offline dictionary attacks expensive.
 *
 * @node-rs/argon2 is a Rust-native binding (faster than the JS-only `argon2`
 * package and no node-gyp build step on Alpine).
 */

const OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS)
}

/**
 * Returns true if `plain` matches the stored hash. Returns false on any
 * verification error (corrupt hash, library failure, mismatch) — we never
 * want to throw out of a login route based on user-controlled input.
 *
 * Constant-time within argon2's internal compare; the wrapper itself
 * doesn't add timing channels because both branches do the same kind of
 * argon2 work.
 */
export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain)
  } catch {
    return false
  }
}
