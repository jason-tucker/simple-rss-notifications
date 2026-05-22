import { pgTable, uuid, text, boolean, timestamp, integer, customType, index } from 'drizzle-orm/pg-core'
import { users } from './users'

/**
 * Discord webhook sink.
 *
 * The webhook URL itself is the credential — anyone with it can post to
 * the channel as the webhook's identity. We encrypt it at rest with the
 * standard 4-tuple AEAD layout (same as smtp password / resend api_key /
 * ntfy token).
 *
 * `username` and `avatar_url` are optional Discord-side display overrides
 * baked into each POST. `use_embeds=true` wraps each dispatch in a rich
 * Discord embed (title + URL + description); false sends plain `content`.
 */

const bytea = customType<{ data: Buffer; default: false; notNull: false }>({
  dataType() { return 'bytea' },
})

export const sinks_discord_webhook = pgTable(
  'sinks_discord_webhook',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    webhook_url_ciphertext: bytea('webhook_url_ciphertext'),
    webhook_url_iv: bytea('webhook_url_iv'),
    webhook_url_tag: bytea('webhook_url_tag'),
    webhook_url_key_version: integer('webhook_url_key_version').default(1),
    /** Optional display name override (e.g. "Euphoric Notify"). */
    username: text('username'),
    /** Optional avatar URL override (PNG/JPG, served https). */
    avatar_url: text('avatar_url'),
    /** When true, send rich embeds. When false, send plain content text. */
    use_embeds: boolean('use_embeds').notNull().default(true),
    /** True iff the webhook URL hasn't been set yet. */
    incomplete: boolean('incomplete').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    user_idx: index('sinks_discord_webhook_user_idx').on(t.user_id),
  }),
)

export type SinkDiscordWebhook = typeof sinks_discord_webhook.$inferSelect
