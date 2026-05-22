import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core'
import { users } from './users'

/**
 * Server-side session mirror. The JWT cookie carries `jti` (24-byte hex);
 * every protected request looks the row up here. Logout / "logout
 * everywhere" / password-change flows delete or invalidate rows, killing
 * any still-presented JWT for the affected user.
 *
 * The JWT alone would be enough to authenticate (it's signed). The DB
 * mirror exists only so we can REVOKE a still-unexpired JWT — JWTs
 * themselves have no revocation primitive.
 */
export const web_sessions = pgTable(
  'web_sessions',
  {
    jti: text('jti').primaryKey(),
    user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    issued_at: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    user_agent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => ({
    user_idx: index('web_sessions_user_idx').on(t.user_id),
    expires_idx: index('web_sessions_expires_idx').on(t.expires_at),
  }),
)

export type WebSession = typeof web_sessions.$inferSelect
