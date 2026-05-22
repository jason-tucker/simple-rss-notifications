import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { hashPassword } from '@/lib/auth/password'
import { env } from '@/lib/env'

/**
 * First-boot seeder. Idempotent. Runs from worker entry AFTER migrations.
 *
 * Creates a single admin user (`BOOTSTRAP_USERNAME` / `BOOTSTRAP_PASSWORD`,
 * defaults `tucker` / `admin`) with `must_change_password=true`. After the
 * insert succeeds, writes `app_meta.bootstrap_completed_at` so this code
 * NEVER runs again on the same database — preventing accidental password
 * resets if someone changes BOOTSTRAP_PASSWORD in .env later.
 *
 * Safety belt: even if app_meta is wiped, the seeder checks `count(*) > 0`
 * on the users table and bails — it cannot overwrite real users.
 *
 * Set BOOTSTRAP_USERNAME=skip in .env to disable entirely.
 */
export async function bootstrap(log: (msg: string, extra?: Record<string, unknown>) => void): Promise<void> {
  if (env.BOOTSTRAP_USERNAME === 'skip') {
    log('bootstrap-skipped', { reason: 'BOOTSTRAP_USERNAME=skip' })
    return
  }

  // Has the seeder already run on this database? Cheap check.
  const meta = await db.execute<{ value: unknown }>(sql`
    SELECT value FROM app_meta WHERE key = 'bootstrap_completed_at' LIMIT 1
  `)
  if (meta[0]) {
    log('bootstrap-already-completed')
    return
  }

  // Safety belt: never overwrite a non-empty users table.
  const userCount = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM users`)
  if ((userCount[0]?.n ?? 0) > 0) {
    log('bootstrap-skipped', { reason: 'users-not-empty' })
    // Persist the marker so we don't recheck on every reboot.
    await db.execute(sql`
      INSERT INTO app_meta (key, value) VALUES ('bootstrap_completed_at', to_jsonb(now()::text))
      ON CONFLICT (key) DO NOTHING
    `)
    return
  }

  const username = env.BOOTSTRAP_USERNAME.trim().toLowerCase()
  const hash = await hashPassword(env.BOOTSTRAP_PASSWORD)

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO users (username, password_hash, must_change_password)
      VALUES (${username}, ${hash}, true)
      ON CONFLICT (username) DO NOTHING
    `)
    await tx.execute(sql`
      INSERT INTO app_meta (key, value) VALUES ('bootstrap_completed_at', to_jsonb(now()::text))
      ON CONFLICT (key) DO NOTHING
    `)
  })

  log('bootstrap-user-created', { username, must_change_password: true })
}
