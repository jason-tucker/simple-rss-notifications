import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { existsSync } from 'node:fs'
import { db, pg } from './client'

/**
 * Apply pending migrations. Called from the worker's boot sequence —
 * NOT from the web container, so two web replicas can never race the same
 * DDL. The worker is a single instance by design.
 *
 * Migrations folder location depends on environment:
 *   - Production (bundled worker):  /app/migrations  (Dockerfile copies them)
 *   - Local pnpm run db:migrate:   ./src/lib/db/migrations
 *   - Override:                    SRN_MIGRATIONS_PATH=...
 *
 * Drizzle tracks applied tags in the __drizzle_migrations table.
 */
function resolveMigrationsFolder(): string {
  if (process.env.SRN_MIGRATIONS_PATH) return process.env.SRN_MIGRATIONS_PATH
  if (existsSync('/app/migrations')) return '/app/migrations'
  return './src/lib/db/migrations'
}

export async function runMigrations(): Promise<void> {
  const folder = resolveMigrationsFolder()
  console.log(JSON.stringify({ msg: 'running migrations', folder }))
  await migrate(db, { migrationsFolder: folder })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(async () => {
      console.log('migrations applied')
      await pg.end()
    })
    .catch(async (err) => {
      console.error('migration failed:', err)
      await pg.end()
      process.exit(1)
    })
}
