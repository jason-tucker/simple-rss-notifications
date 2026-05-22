import { pgTable, uuid, text, integer, boolean, timestamp, customType, index } from 'drizzle-orm/pg-core'
import { users } from './users'

/**
 * Outbound notification sinks. Two flavors today (SMTP, Resend); ntfy
 * publishing arrives in a later PR (it's an unencrypted bearer token).
 *
 * Every encrypted field is a 4-tuple (ciphertext, iv, tag, key_version) —
 * see lib/crypto/aead.ts for the layout rationale.
 *
 * `incomplete=true` marks a sink that's missing required credentials
 * (typically the password was left blank during bootstrap). The dashboard
 * shows a yellow banner and the dispatcher refuses to use these.
 */

// drizzle's bytea customType — needed because the default `bytea()` helper
// isn't exported in the pgCore types we're on.
const bytea = customType<{ data: Buffer; default: false; notNull: false }>({
  dataType() { return 'bytea' },
})

export const sinks_smtp = pgTable(
  'sinks_smtp',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull().default(587),
    username: text('username').notNull(),
    // Encrypted password — nullable so bootstrap can pre-seed a sink with
    // the connection metadata and let the user paste the password later.
    password_ciphertext: bytea('password_ciphertext'),
    password_iv: bytea('password_iv'),
    password_tag: bytea('password_tag'),
    password_key_version: integer('password_key_version').default(1),
    from_email: text('from_email').notNull(),
    from_name: text('from_name'),
    // STARTTLS on port 587, implicit TLS on 465. Defaults to true; users
    // who really need cleartext SMTP can flip it to false in the edit form.
    use_tls: boolean('use_tls').notNull().default(true),
    incomplete: boolean('incomplete').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    user_idx: index('sinks_smtp_user_idx').on(t.user_id),
  }),
)

export const sinks_resend = pgTable(
  'sinks_resend',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    api_key_ciphertext: bytea('api_key_ciphertext'),
    api_key_iv: bytea('api_key_iv'),
    api_key_tag: bytea('api_key_tag'),
    api_key_key_version: integer('api_key_key_version').default(1),
    from_email: text('from_email').notNull(),
    from_name: text('from_name'),
    incomplete: boolean('incomplete').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    user_idx: index('sinks_resend_user_idx').on(t.user_id),
  }),
)

export type SinkSmtp = typeof sinks_smtp.$inferSelect
export type SinkResend = typeof sinks_resend.$inferSelect
