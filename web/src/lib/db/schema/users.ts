import { pgTable, uuid, text, timestamp, boolean, index } from 'drizzle-orm/pg-core'

/**
 * Multi-user app. Username + password (argon2id, hash lands in PR3).
 *
 * `reauth_password_hash` is a SEPARATE password used to gate sensitive
 * operations in the UI (revealing or changing a stored SMTP password,
 * Resend API key, ntfy bearer token, or the account password itself).
 * Successful reauth mints a fresh JWT with an `elevatedUntil` claim
 * valid 10 minutes — see lib/auth/reauth.ts (PR4).
 *
 * `password_changed_at` is checked against every incoming JWT's `iat` to
 * invalidate sessions on password change without a per-row revocation step.
 * `must_change_password` forces a password-change page on first login
 * for the bootstrap user (`tucker / admin` by default).
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull().unique(),
    password_hash: text('password_hash').notNull(),
    reauth_password_hash: text('reauth_password_hash'),
    must_change_password: boolean('must_change_password').notNull().default(false),
    // Admin role — gates the user-management API (/api/users) and UI
    // (/dashboard/admin/users). Added in migration 0011_users_is_admin.
    is_admin: boolean('is_admin').notNull().default(false),
    password_changed_at: timestamp('password_changed_at', { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    username_lower_idx: index('users_username_lower_idx').on(t.username),
  }),
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
