import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'
import { users } from './users'

/**
 * Audit log. Every state-changing API route calls writeAudit(...) with
 * `actor`, `action`, `target_type`, `target_id`, `before`, `after`, `via`.
 *
 * Stored secrets (SMTP password, Resend key, ntfy token) are NEVER
 * included in `before`/`after` — substitute the literal string
 * "[REDACTED]" instead. Use the helper in lib/audit.ts (PR3) so this
 * is hard to get wrong.
 */
export const audit_log = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actor_user_id: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    target_type: text('target_type').notNull(),
    target_id: text('target_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    via: text('via').notNull().default('web'),
    ip: text('ip'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actor_idx: index('audit_log_actor_idx').on(t.actor_user_id, t.created_at),
    target_idx: index('audit_log_target_idx').on(t.target_type, t.target_id, t.created_at),
  }),
)

export type AuditRow = typeof audit_log.$inferSelect
export type NewAuditRow = typeof audit_log.$inferInsert
