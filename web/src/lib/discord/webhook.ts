import 'server-only'
import type { SinkDiscordWebhook } from '@/lib/db/schema'
import { decrypt } from '@/lib/crypto/aead'
import { checkSafeOutboundUrl } from '@/lib/ssrf'
import type { SendResult } from '@/lib/email/send'

const DISCORD_TIMEOUT_MS = 15_000

export interface DiscordPublishArgs {
  /** Becomes the embed title (when use_embeds=true) or the prefix in content. */
  title?: string
  /** Free text body / embed description. */
  message: string
  /** Optional link — when set + use_embeds, becomes the embed URL. */
  link?: string
  /** Idempotency tag, included in the request body so logs can correlate. */
  idempotencyKey?: string
  /**
   * Full rich-embed object that overrides the default {title, description, url}
   * shape — lets the caller supply author, timestamp, footer, color, fields.
   * Falls back to the simple form when not set. Typed as JSON-shaped object
   * so callers with their own narrower interfaces (lib/rss/format.ts's
   * DiscordEmbed) assign without ceremony.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  embed?: Record<string, any>
}

/**
 * POST to a Discord webhook URL.
 *
 * Discord doesn't authenticate via header — the secret IS the URL.
 * SSRF guard runs on every call because the URL is user-supplied; the
 * guard rejects private/cloud-metadata/loopback addresses to keep a
 * malicious URL from probing internal services.
 *
 * Two send modes:
 *   - use_embeds=true:  rich card with title + description + URL
 *   - use_embeds=false: plain `content` text (max 2000 chars)
 *
 * Discord rate-limits webhook requests (~30/min per channel). We don't
 * pre-throttle here — the dispatcher's MAX_ATTEMPTS + exp backoff will
 * absorb the occasional 429.
 */
export async function publishToDiscord(sink: SinkDiscordWebhook, args: DiscordPublishArgs): Promise<SendResult> {
  if (sink.incomplete) {
    return { ok: false, error: 'sink is incomplete (webhook URL not set)', code: 'sink-incomplete' }
  }

  let url: string | null = null
  try {
    if (sink.webhook_url_ciphertext && sink.webhook_url_iv && sink.webhook_url_tag && sink.webhook_url_key_version != null) {
      url = decrypt({
        ciphertext: sink.webhook_url_ciphertext as Buffer,
        iv: sink.webhook_url_iv as Buffer,
        tag: sink.webhook_url_tag as Buffer,
        keyVersion: sink.webhook_url_key_version,
      })
    }
  } catch {
    return { ok: false, error: 'failed to decrypt Discord webhook URL', code: 'decrypt-failed' }
  }
  if (!url) {
    return { ok: false, error: 'Discord webhook URL not set', code: 'sink-incomplete' }
  }

  const ssrf = await checkSafeOutboundUrl(url)
  if (ssrf) return { ok: false, error: ssrf, code: 'ssrf-blocked' }

  // Discord's `wait=true` makes the POST synchronous and returns the
  // posted message JSON so we can capture the message id for audit.
  const finalUrl = url.includes('?') ? `${url}&wait=true` : `${url}?wait=true`

  const body: Record<string, unknown> = {}
  if (sink.username) body.username = sink.username
  if (sink.avatar_url) body.avatar_url = sink.avatar_url

  if (sink.use_embeds) {
    // Caller-provided rich embed wins (dispatcher passes one assembled
    // from the feed item). Otherwise fall back to the minimal shape.
    if (args.embed) {
      body.embeds = [args.embed]
    } else {
      const embed: Record<string, unknown> = {
        title: (args.title ?? 'Notification').slice(0, 256),
        description: args.message.slice(0, 4000),
      }
      if (args.link) embed.url = args.link
      body.embeds = [embed]
    }
  } else {
    const lines = [args.title, args.message, args.link].filter(Boolean) as string[]
    body.content = lines.join('\n').slice(0, 2000)
  }

  try {
    const res = await fetch(finalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        ok: false,
        error: text.slice(0, 500) || `HTTP ${res.status}`,
        code: `discord-http-${res.status}`,
      }
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string }
    return { ok: true, providerMessageId: data.id }
  } catch (err) {
    // Don't stringify the error object — could contain the webhook URL.
    const message = err instanceof Error ? err.message : 'fetch failed'
    return { ok: false, error: message, code: 'discord-network' }
  }
}
