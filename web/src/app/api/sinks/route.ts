import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { withAuth } from '@/lib/auth/withAuth'
import { withUser } from '@/lib/db/withUser'
import { encrypt } from '@/lib/crypto/aead'
import { writeAudit, redactSecretFields } from '@/lib/audit'
import { checkSafeOutboundUrl } from '@/lib/ssrf'

export const dynamic = 'force-dynamic'

/**
 * GET  /api/sinks       → list all sinks for the current user, secrets redacted
 * POST /api/sinks       → create a new SMTP, Resend, or ntfy sink
 *
 * Per-item edit and delete live at /api/sinks/[type]/[id].
 *
 * Returned sink rows NEVER include the encrypted ciphertext. Callers see
 * only: type, id, label, public connection fields, incomplete flag,
 * has_secret (boolean), timestamps.
 */

interface ListedSink {
  type: 'smtp' | 'resend' | 'ntfy' | 'discord_webhook'
  id: string
  label: string
  // email
  from_email?: string
  from_name?: string | null
  // smtp
  host?: string
  port?: number
  username?: string
  use_tls?: boolean
  // ntfy
  server_url?: string
  topic?: string
  default_priority?: number
  default_tags?: string | null
  include_link?: boolean
  // discord_webhook
  avatar_url?: string | null
  use_embeds?: boolean
  // (username is shared with smtp but means a different thing here — Discord display name)
  incomplete: boolean
  has_secret: boolean
  created_at: string
  updated_at: string
}

export const GET = withAuth(async (_req, { session }) => {
  return withUser(session.uid, async (tx) => {
    const smtp = await tx.execute<{
      id: string; label: string; host: string; port: number; username: string
      from_email: string; from_name: string | null; use_tls: boolean
      incomplete: boolean; has_secret: boolean
      created_at: Date; updated_at: Date
    }>(sql`
      SELECT id, label, host, port, username, from_email, from_name, use_tls,
             incomplete, (password_ciphertext IS NOT NULL) AS has_secret,
             created_at, updated_at
      FROM sinks_smtp ORDER BY created_at
    `)
    const resend = await tx.execute<{
      id: string; label: string; from_email: string; from_name: string | null
      incomplete: boolean; has_secret: boolean
      created_at: Date; updated_at: Date
    }>(sql`
      SELECT id, label, from_email, from_name,
             incomplete, (api_key_ciphertext IS NOT NULL) AS has_secret,
             created_at, updated_at
      FROM sinks_resend ORDER BY created_at
    `)
    const ntfy = await tx.execute<{
      id: string; label: string; server_url: string; topic: string
      default_priority: number; default_tags: string | null; include_link: boolean
      incomplete: boolean; has_secret: boolean
      created_at: Date; updated_at: Date
    }>(sql`
      SELECT id, label, server_url, topic, default_priority, default_tags, include_link,
             incomplete, (token_ciphertext IS NOT NULL) AS has_secret,
             created_at, updated_at
      FROM sinks_ntfy ORDER BY created_at
    `)
    const discord = await tx.execute<{
      id: string; label: string; username: string | null; avatar_url: string | null
      use_embeds: boolean; incomplete: boolean; has_secret: boolean
      created_at: Date; updated_at: Date
    }>(sql`
      SELECT id, label, username, avatar_url, use_embeds, incomplete,
             (webhook_url_ciphertext IS NOT NULL) AS has_secret,
             created_at, updated_at
      FROM sinks_discord_webhook ORDER BY created_at
    `)
    const out: ListedSink[] = [
      ...smtp.map((s) => ({
        type: 'smtp' as const,
        id: s.id, label: s.label, host: s.host, port: s.port, username: s.username,
        from_email: s.from_email, from_name: s.from_name, use_tls: s.use_tls,
        incomplete: s.incomplete, has_secret: s.has_secret,
        created_at: new Date(s.created_at).toISOString(),
        updated_at: new Date(s.updated_at).toISOString(),
      })),
      ...resend.map((s) => ({
        type: 'resend' as const,
        id: s.id, label: s.label,
        from_email: s.from_email, from_name: s.from_name,
        incomplete: s.incomplete, has_secret: s.has_secret,
        created_at: new Date(s.created_at).toISOString(),
        updated_at: new Date(s.updated_at).toISOString(),
      })),
      ...ntfy.map((s) => ({
        type: 'ntfy' as const,
        id: s.id, label: s.label,
        server_url: s.server_url, topic: s.topic,
        default_priority: s.default_priority, default_tags: s.default_tags,
        include_link: s.include_link,
        incomplete: s.incomplete, has_secret: s.has_secret,
        created_at: new Date(s.created_at).toISOString(),
        updated_at: new Date(s.updated_at).toISOString(),
      })),
      ...discord.map((s) => ({
        type: 'discord_webhook' as const,
        id: s.id, label: s.label,
        username: s.username ?? undefined,
        avatar_url: s.avatar_url, use_embeds: s.use_embeds,
        incomplete: s.incomplete, has_secret: s.has_secret,
        created_at: new Date(s.created_at).toISOString(),
        updated_at: new Date(s.updated_at).toISOString(),
      })),
    ]
    return NextResponse.json({ sinks: out })
  })
})

const SmtpBody = z.object({
  type: z.literal('smtp'),
  label: z.string().min(1).max(100),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(1024).optional(),
  from_email: z.string().email(),
  from_name: z.string().max(100).optional().nullable(),
  use_tls: z.boolean().default(true),
})

const ResendBody = z.object({
  type: z.literal('resend'),
  label: z.string().min(1).max(100),
  api_key: z.string().min(1).max(1024).optional(),
  from_email: z.string().email(),
  from_name: z.string().max(100).optional().nullable(),
})

const NtfyBody = z.object({
  type: z.literal('ntfy'),
  label: z.string().min(1).max(100),
  server_url: z.string().url().max(2048).default('https://ntfy.sh'),
  topic: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'topic must be alphanumeric, dash, or underscore'),
  token: z.string().max(1024).optional(),
  default_priority: z.number().int().min(1).max(5).default(3),
  default_tags: z.string().max(200).optional().nullable(),
  include_link: z.boolean().default(true),
})

const DiscordWebhookBody = z.object({
  type: z.literal('discord_webhook'),
  label: z.string().min(1).max(100),
  webhook_url: z
    .string()
    .url()
    .max(2048)
    .regex(/^https:\/\/(discord\.com|ptb\.discord\.com|canary\.discord\.com|discordapp\.com)\/api\/webhooks\//,
      'webhook URL must be a discord.com/api/webhooks/... link')
    .optional(),
  username: z.string().max(80).optional().nullable(),
  avatar_url: z.string().url().max(2048).optional().nullable(),
  use_embeds: z.boolean().default(true),
})

const Body = z.discriminatedUnion('type', [SmtpBody, ResendBody, NtfyBody, DiscordWebhookBody])

export const POST = withAuth(async (req, { session, ip }) => {
  const json = await req.json().catch(() => null)
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-request', issues: parsed.error.issues }, { status: 400 })
  }

  if (parsed.data.type === 'ntfy') {
    // Catch obvious SSRF up-front (private IPs, cloud metadata). The
    // dispatcher re-checks every call too, but failing fast in the UI
    // is friendlier.
    const ssrf = await checkSafeOutboundUrl(parsed.data.server_url)
    if (ssrf) return NextResponse.json({ error: ssrf, code: 'ssrf-blocked' }, { status: 400 })
  }

  return withUser(session.uid, async (tx) => {
    if (parsed.data.type === 'smtp') {
      const enc = parsed.data.password ? encrypt(parsed.data.password) : null
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO sinks_smtp (
          user_id, label, host, port, username,
          password_ciphertext, password_iv, password_tag, password_key_version,
          from_email, from_name, use_tls, incomplete
        )
        VALUES (
          ${session.uid}::uuid, ${parsed.data.label}, ${parsed.data.host}, ${parsed.data.port}, ${parsed.data.username},
          ${enc?.ciphertext ?? null}, ${enc?.iv ?? null}, ${enc?.tag ?? null}, ${enc?.keyVersion ?? null},
          ${parsed.data.from_email}, ${parsed.data.from_name ?? null}, ${parsed.data.use_tls}, ${!enc}
        )
        RETURNING id
      `)
      const id = rows[0]!.id
      void writeAudit({
        actor_user_id: session.uid,
        action: 'sink.create',
        target_type: 'sink_smtp',
        target_id: id,
        after: redactSecretFields(parsed.data, ['password']),
        via: 'web',
        ip,
      })
      return NextResponse.json({ ok: true, id, type: 'smtp' })
    }

    if (parsed.data.type === 'resend') {
      const enc = parsed.data.api_key ? encrypt(parsed.data.api_key) : null
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO sinks_resend (
          user_id, label,
          api_key_ciphertext, api_key_iv, api_key_tag, api_key_key_version,
          from_email, from_name, incomplete
        )
        VALUES (
          ${session.uid}::uuid, ${parsed.data.label},
          ${enc?.ciphertext ?? null}, ${enc?.iv ?? null}, ${enc?.tag ?? null}, ${enc?.keyVersion ?? null},
          ${parsed.data.from_email}, ${parsed.data.from_name ?? null}, ${!enc}
        )
        RETURNING id
      `)
      const id = rows[0]!.id
      void writeAudit({
        actor_user_id: session.uid,
        action: 'sink.create',
        target_type: 'sink_resend',
        target_id: id,
        after: redactSecretFields(parsed.data, ['api_key']),
        via: 'web',
        ip,
      })
      return NextResponse.json({ ok: true, id, type: 'resend' })
    }

    if (parsed.data.type === 'ntfy') {
      const enc = parsed.data.token ? encrypt(parsed.data.token) : null
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO sinks_ntfy (
          user_id, label, server_url, topic,
          token_ciphertext, token_iv, token_tag, token_key_version,
          default_priority, default_tags, include_link, incomplete
        )
        VALUES (
          ${session.uid}::uuid, ${parsed.data.label}, ${parsed.data.server_url}, ${parsed.data.topic},
          ${enc?.ciphertext ?? null}, ${enc?.iv ?? null}, ${enc?.tag ?? null}, ${enc?.keyVersion ?? null},
          ${parsed.data.default_priority}, ${parsed.data.default_tags ?? null}, ${parsed.data.include_link}, false
        )
        RETURNING id
      `)
      const id = rows[0]!.id
      void writeAudit({
        actor_user_id: session.uid,
        action: 'sink.create',
        target_type: 'sink_ntfy',
        target_id: id,
        after: redactSecretFields(parsed.data, ['token']),
        via: 'web',
        ip,
      })
      return NextResponse.json({ ok: true, id, type: 'ntfy' })
    }

    // type === 'discord_webhook'
    const enc = parsed.data.webhook_url ? encrypt(parsed.data.webhook_url) : null
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO sinks_discord_webhook (
        user_id, label,
        webhook_url_ciphertext, webhook_url_iv, webhook_url_tag, webhook_url_key_version,
        username, avatar_url, use_embeds, incomplete
      )
      VALUES (
        ${session.uid}::uuid, ${parsed.data.label},
        ${enc?.ciphertext ?? null}, ${enc?.iv ?? null}, ${enc?.tag ?? null}, ${enc?.keyVersion ?? null},
        ${parsed.data.username ?? null}, ${parsed.data.avatar_url ?? null}, ${parsed.data.use_embeds}, ${!enc}
      )
      RETURNING id
    `)
    const id = rows[0]!.id
    void writeAudit({
      actor_user_id: session.uid,
      action: 'sink.create',
      target_type: 'sink_discord_webhook',
      target_id: id,
      after: redactSecretFields(parsed.data, ['webhook_url']),
      via: 'web',
      ip,
    })
    return NextResponse.json({ ok: true, id, type: 'discord_webhook' })
  })
})
