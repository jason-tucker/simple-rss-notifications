import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { env } from '@/lib/env'
import * as schema from './schema'

/**
 * One process-wide postgres-js client. drizzle wraps it.
 *
 * Both web and worker connect as the database OWNER (POSTGRES_USER, set
 * in .env / docker-compose). The owner bypasses RLS by default (we did
 * NOT enable FORCE ROW LEVEL SECURITY), which is exactly what we want:
 *
 *   - Worker: runs migrations, bootstrap, RSS poller, dispatcher — all
 *             of which need cross-user visibility. Owner-level access.
 *
 *   - Web:    request handlers wrap user-scoped work in `withUser(userId, fn)`.
 *             That helper opens a transaction and does
 *               SET LOCAL ROLE web_role;
 *               SELECT set_config('app.current_user_id', '<uuid>', true);
 *             which DEMOTES the connection out of owner privileges for the
 *             duration of the transaction — RLS policies then apply as
 *             expected. Outside withUser the web connection is still owner,
 *             so admin/login flows (no userId yet) work normally.
 *
 * postgres-js handles reconnect automatically. LISTEN/NOTIFY subscribers
 * (PR6) MUST re-issue LISTEN on each new connection — postgres-js does NOT
 * replay listens on reconnect.
 */
export const pg = postgres(env.DATABASE_URL, {
  max: env.SRN_ROLE === 'worker' ? 4 : 10,
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: () => { /* swallow NOTICE chatter */ },
  connection: {
    application_name: `srn-${env.SRN_ROLE}`,
  },
  prepare: false,
})

export const db = drizzle(pg, { schema })

export { schema }
