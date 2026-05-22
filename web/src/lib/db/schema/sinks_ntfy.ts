import { pgTable, uuid, text, integer, boolean, timestamp, customType, index } from 'drizzle-orm/pg-core'
import { users } from './users'

/**
 * ntfy sink — push notification destination.
 *
 * Routing model differs from SMTP/Resend: the destination (the ntfy topic)
 * lives on the sink itself, not on the route. The `routes.destination`
 * column is therefore nullable; for ntfy routes the dispatcher uses
 * sink.server_url + sink.topic verbatim.
 *
 * Topics can be public (no auth) or protected (bearer token). The token
 * is optional — if the topic is public, leave the token blank and
 * `incomplete` stays false. If protected: paste the token; dispatcher
 * sends `Authorization: Bearer <token>`. Tokens encrypted at rest with
 * the same AEAD 4-tuple layout as the other sinks.
 *
 * default_priority follows ntfy's 1-5 scale (1=min, 3=default, 5=max).
 * default_tags is a comma-separated string of ntfy tag names or emojis.
 */

const bytea = customType<{ data: Buffer; default: false; notNull: false }>({
  dataType() { return 'bytea' },
})

export const sinks_ntfy = pgTable(
  'sinks_ntfy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    server_url: text('server_url').notNull().default('https://ntfy.sh'),
    topic: text('topic').notNull(),
    /**
     * Optional bearer token for protected topics. NULL for public topics.
     * Note `incomplete` does NOT depend on this being NULL — many ntfy
     * topics are public, and we'd rather not flag those as broken.
     */
    token_ciphertext: bytea('token_ciphertext'),
    token_iv: bytea('token_iv'),
    token_tag: bytea('token_tag'),
    token_key_version: integer('token_key_version').default(1),
    /** 1=min, 2=low, 3=default, 4=high, 5=max. */
    default_priority: integer('default_priority').notNull().default(3),
    /** Comma-separated. ntfy renders these as emoji prefixes on the push. */
    default_tags: text('default_tags'),
    /** When true, the dispatcher adds the feed item's link as a Click header. */
    include_link: boolean('include_link').notNull().default(true),
    /**
     * Currently always false for ntfy — token is optional, so there's no
     * "incomplete" state for a public topic. Kept on the schema for
     * parity with the other sink tables and a future "require auth" UX.
     */
    incomplete: boolean('incomplete').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    user_idx: index('sinks_ntfy_user_idx').on(t.user_id),
  }),
)

export type SinkNtfy = typeof sinks_ntfy.$inferSelect
