import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'

/**
 * Write an audit_log row for any state-changing action.
 *
 * IMPORTANT: stored secrets (SMTP password, Resend API key, ntfy bearer
 * token) MUST NEVER appear in `before` or `after`. Substitute the literal
 * string '[REDACTED]' instead. `redactSecretFields()` below is a tiny
 * helper for the common shape.
 *
 * Failure is non-fatal — a transient DB blip should not break the user-
 * facing operation. We log the failure and continue. If audit becomes
 * a hard compliance requirement later, swap this to throw.
 */
export async function writeAudit(row: {
  actor_user_id: string | null
  action: string
  target_type: string
  target_id?: string | null
  before?: unknown
  after?: unknown
  via?: string
  ip?: string | null
}): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO audit_log (actor_user_id, action, target_type, target_id, before, after, via, ip)
      VALUES (
        ${row.actor_user_id}::uuid,
        ${row.action},
        ${row.target_type},
        ${row.target_id ?? null},
        ${row.before === undefined ? null : JSON.stringify(row.before)}::jsonb,
        ${row.after === undefined ? null : JSON.stringify(row.after)}::jsonb,
        ${row.via ?? 'web'},
        ${row.ip ?? null}
      )
    `)
  } catch (err) {
    console.error(JSON.stringify({
      msg: 'writeAudit failed',
      action: row.action,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
}

/**
 * Redact any field listed in `keys` to '[REDACTED]' before audit-logging.
 * Use this for sink creates/updates where `body` includes a password
 * field — pass `redactSecretFields(body, ['password'])` as the `after`.
 */
export function redactSecretFields<T extends Record<string, unknown>>(
  obj: T,
  keys: Array<keyof T>,
): T {
  const out = { ...obj } as Record<string, unknown>
  for (const k of keys) {
    if (out[k as string] !== undefined && out[k as string] !== null && out[k as string] !== '') {
      out[k as string] = '[REDACTED]'
    }
  }
  return out as T
}
