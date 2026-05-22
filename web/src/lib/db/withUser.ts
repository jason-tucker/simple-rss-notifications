import { sql } from 'drizzle-orm'
import { db } from './client'

/**
 * Run a block of DB work scoped to a specific user. Every web request that
 * touches user data MUST go through this wrapper — it sets the Postgres
 * GUC that RLS policies read.
 *
 *   await withUser(userId, async (tx) => {
 *     const feeds = await tx.select().from(schema.feeds)  // RLS-scoped
 *     await tx.insert(schema.feeds).values({ ... })       // RLS-scoped
 *   })
 *
 * The transaction wrapper is mandatory because:
 *   1. postgres-js pools connections. A session-level SET would leak across
 *      requests. SET LOCAL is bound to the current transaction and reverts
 *      on commit/rollback.
 *   2. Multiple sequential queries in one logical user-action stay atomic.
 *
 * Performance: an empty transaction adds ~0.3ms over a raw query — fine
 * for any request that does real work.
 *
 * Security: the userId parameter is passed via parameterized `set_config`
 * call, NOT string-interpolated, so a maliciously-crafted userId cannot
 * SQL-inject. Same for SET LOCAL ROLE — we hardcode the literal 'web_role'.
 */
export async function withUser<T>(
  userId: string,
  fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Hardcoded role name — no user-controlled input. The connecting login
    // user must have been GRANT'd web_role (migration 0001 does this).
    await tx.execute(sql`SET LOCAL ROLE web_role`)
    // Parameterized GUC set. set_config(name, value, is_local) returns the
    // new value; we ignore it. is_local=true scopes the change to this txn.
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`)
    return fn(tx)
  })
}
