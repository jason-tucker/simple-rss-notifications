import 'server-only'
import type { SinkNtfy } from '@/lib/db/schema'
import { decrypt } from '@/lib/crypto/aead'
import { safeFetch, SsrfBlockedError, readCappedText } from '@/lib/ssrf'
import type { SendResult } from '@/lib/email/send'

const NTFY_TIMEOUT_MS = 15_000
const MAX_ERROR_BODY_BYTES = 8 * 1024

export interface NtfyPublishArgs {
  /** Becomes the ntfy `Title:` header. Falls back to topic name if missing. */
  title?: string
  /** Notification body. */
  message: string
  /** 1–5; overrides sink.default_priority when set. */
  priority?: number
  /** Comma-separated ntfy tag names / emojis; overrides sink.default_tags when set. */
  tags?: string
  /** Optional click action URL. */
  click?: string
  /** Idempotency for dispatcher retries. ntfy itself doesn't dedup by this
   *  header, but we send it anyway so logs can correlate. */
  idempotencyKey?: string
}

/**
 * POST to `${server_url}/${topic}` with the ntfy headers protocol.
 *
 * Auth: protected topics use `Authorization: Bearer <token>`. Public
 * topics (no token configured) skip the header.
 *
 * SSRF guard runs on every call because the user can edit server_url
 * to anything — a malicious user under a multi-tenant deployment could
 * otherwise probe Docker-internal services or cloud metadata.
 *
 * The redaction in the catch block is intentional: even on transport
 * errors, we never log the full Authorization header or the token.
 */
export async function publishToNtfy(sink: SinkNtfy, args: NtfyPublishArgs): Promise<SendResult> {
  const base = sink.server_url.replace(/\/+$/, '')
  const url = `${base}/${encodeURIComponent(sink.topic)}`

  let token: string | null = null
  if (sink.token_ciphertext && sink.token_iv && sink.token_tag && sink.token_key_version != null) {
    try {
      token = decrypt({
        ciphertext: sink.token_ciphertext as Buffer,
        iv: sink.token_iv as Buffer,
        tag: sink.token_tag as Buffer,
        keyVersion: sink.token_key_version,
      })
    } catch {
      return { ok: false, error: 'failed to decrypt ntfy token', code: 'decrypt-failed' }
    }
  }

  // ntfy reads headers for metadata and the body for the message. Headers
  // must be ASCII; ntfy supports RFC 2047 encoding for Unicode titles, but
  // we keep it simple and strip control chars instead. Long titles get
  // truncated to ntfy's limit (~250 chars).
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8',
  }
  if (args.title) {
    headers['Title'] = sanitizeHeader(args.title).slice(0, 250)
  }
  const priority = args.priority ?? sink.default_priority
  if (priority && priority >= 1 && priority <= 5) {
    headers['Priority'] = String(priority)
  }
  const tags = args.tags ?? sink.default_tags
  if (tags) {
    headers['Tags'] = sanitizeHeader(tags)
  }
  // `args.click` is a feed item link (attacker-controlled). Strip CR/LF +
  // control chars to prevent header injection, and only forward it when it's
  // a real http(s) URL — otherwise drop it.
  if (args.click) {
    const click = sanitizeHeader(args.click)
    if (isHttpUrl(click)) headers['Click'] = click
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  try {
    const res = await safeFetch(url, {
      method: 'POST',
      headers,
      body: args.message,
      timeoutMs: NTFY_TIMEOUT_MS,
    })

    if (!res.ok) {
      const text = await readCappedText(res.body, MAX_ERROR_BODY_BYTES).catch(() => '')
      return {
        ok: false,
        error: text.slice(0, 500) || `HTTP ${res.status}`,
        code: `ntfy-http-${res.status}`,
      }
    }

    // ntfy returns JSON with {id, time, ...}. We treat id as the provider
    // message id for audit log + dispatch tracking.
    const text = await readCappedText(res.body, MAX_ERROR_BODY_BYTES).catch(() => '')
    let id: string | undefined
    try {
      id = (JSON.parse(text) as { id?: string }).id
    } catch {
      id = undefined
    }
    return { ok: true, providerMessageId: id }
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      return { ok: false, error: err.message, code: 'ssrf-blocked' }
    }
    // NEVER stringify the error verbatim — errors may include the full
    // request URL with the Authorization header in some builds. Only the
    // message field (never the token) is included in the response.
    const message = err instanceof Error ? err.message : 'fetch failed'
    return { ok: false, error: message, code: 'ntfy-network' }
  }
}

/** True if `s` parses as an http(s) URL. */
function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function sanitizeHeader(s: string): string {
  // Strip CR/LF (header injection), control chars, and anything outside
  // printable ASCII. ntfy supports UTF-8 in Title via RFC 2047 encoding,
  // but plain ASCII Title is universally safe and adequate.
  return s.replace(/[\r\n\t]/g, ' ').replace(/[^\x20-\x7E]/g, '?').trim()
}
