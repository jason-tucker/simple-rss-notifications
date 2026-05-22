import { sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { hashPassword } from '@/lib/auth/password'
import { env } from '@/lib/env'

type Logger = (msg: string, extra?: Record<string, unknown>) => void

/**
 * First-boot seeders. Each step has its OWN `app_meta` marker so they
 * can be added incrementally over the project's lifetime and still seed
 * correctly on existing databases (where earlier-step markers already
 * exist). Each is independently idempotent.
 *
 * Set BOOTSTRAP_USERNAME=skip in .env to disable all seeding entirely.
 *
 * Markers:
 *   bootstrap_completed_at  — user row created (PR3)
 *   ionos_sink_seeded_at    — IONOS SMTP sink row created (PR4)
 */
export async function bootstrap(log: Logger): Promise<void> {
  if (env.BOOTSTRAP_USERNAME === 'skip') {
    log('bootstrap-skipped', { reason: 'BOOTSTRAP_USERNAME=skip' })
    return
  }
  await seedUser(log)
  await seedIonosSink(log)
}

async function hasMarker(key: string): Promise<boolean> {
  const rows = await db.execute<{ value: unknown }>(sql`
    SELECT value FROM app_meta WHERE key = ${key} LIMIT 1
  `)
  return rows.length > 0
}

async function setMarker(tx: typeof db, key: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO app_meta (key, value) VALUES (${key}, to_jsonb(now()::text))
    ON CONFLICT (key) DO NOTHING
  `)
}

async function findBootstrapUserId(): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM users WHERE username = ${env.BOOTSTRAP_USERNAME.trim().toLowerCase()} LIMIT 1
  `)
  return rows[0]?.id ?? null
}

/** Create the bootstrap user iff users table is empty AND marker missing. */
async function seedUser(log: Logger): Promise<void> {
  if (await hasMarker('bootstrap_completed_at')) {
    log('bootstrap-user-already-completed')
    return
  }

  const userCount = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM users`)
  if ((userCount[0]?.n ?? 0) > 0) {
    log('bootstrap-user-skipped', { reason: 'users-not-empty' })
    await db.transaction(async (tx) => { await setMarker(tx as unknown as typeof db, 'bootstrap_completed_at') })
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
    await setMarker(tx as unknown as typeof db, 'bootstrap_completed_at')
  })

  log('bootstrap-user-created', { username, must_change_password: true })
}

/**
 * Seed the IONOS SMTP sink for the bootstrap user. Independent marker
 * (`ionos_sink_seeded_at`) so this still runs on databases that were
 * bootstrapped before this code shipped.
 *
 * Password is left NULL (incomplete=true). The UI banner prompts the
 * user to paste the password; until then the dispatcher refuses to
 * route through this sink.
 */
async function seedIonosSink(log: Logger): Promise<void> {
  if (await hasMarker('ionos_sink_seeded_at')) {
    log('bootstrap-ionos-sink-already-seeded')
    return
  }

  const userId = await findBootstrapUserId()
  if (!userId) {
    log('bootstrap-ionos-sink-skipped', { reason: 'bootstrap-user-not-found' })
    return
  }

  // Defensive: if a sink with this label already exists for this user
  // (someone created it by hand), just record the marker and stop.
  const existing = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM sinks_smtp
    WHERE user_id = ${userId}::uuid AND label = 'IONOS'
  `)
  if ((existing[0]?.n ?? 0) > 0) {
    await db.transaction(async (tx) => { await setMarker(tx as unknown as typeof db, 'ionos_sink_seeded_at') })
    log('bootstrap-ionos-sink-skipped', { reason: 'label-already-exists' })
    return
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO sinks_smtp (
        user_id, label, host, port, username,
        from_email, from_name, use_tls, incomplete
      ) VALUES (
        ${userId}::uuid, 'IONOS', 'smtp.ionos.com', 587, 'online@jasontucker.me',
        'online@jasontucker.me', NULL, true, true
      )
    `)
    await setMarker(tx as unknown as typeof db, 'ionos_sink_seeded_at')
  })

  log('bootstrap-ionos-sink-created', { host: 'smtp.ionos.com', incomplete: true })
}
