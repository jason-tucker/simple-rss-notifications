/**
 * CLI entry for migrations. Invoked via `pnpm db:migrate` for local-dev runs.
 * Production migrations apply on worker boot (src/worker/index.ts) — this
 * file is intentionally NOT bundled by esbuild.
 */
import { runMigrations } from '../src/lib/db/migrate.js'
import { pg } from '../src/lib/db/client.js'

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
