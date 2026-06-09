import 'server-only'
import nodemailer from 'nodemailer'
import type { SinkSmtp, SinkResend } from '@/lib/db/schema'
import { decrypt } from '@/lib/crypto/aead'
import { isPrivateHost, readCappedText } from '@/lib/ssrf'

const MAX_ERROR_BODY_BYTES = 8 * 1024

// SMTP connection-level error codes that, if surfaced verbatim, turn the
// dispatcher into an internal port-scan oracle (refused vs. timed out vs.
// no-such-host distinguishes open/closed/filtered ports + DNS existence).
// We collapse all of these to one generic message; the real code/message
// stays in server logs only.
const SMTP_CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'EHOSTDOWN',
  'EPIPE',
  'ESOCKET',
  'ECONNECTION',
  'ETLS',
])
const GENERIC_SMTP_CONNECTION_ERROR = 'could not connect to the SMTP server'

/**
 * Outbound email adapter. Two backends:
 *   - SMTP via nodemailer
 *   - Resend API via fetch (no SDK dep — Resend's REST is simple enough)
 *
 * Both return a normalized result so dispatcher code (PR5+) doesn't care
 * which it's calling. Errors include a `code` so the UI can render
 * actionable messages (auth-failed vs network vs from-address rejected).
 */

export interface SendArgs {
  to: string
  subject: string
  /** Plain-text body — used as the fallback for clients that don't render html. */
  text?: string
  /** HTML body — preferred by every modern mail client. */
  html?: string
  /** Set to ensure SMTP servers don't double-send on dispatcher retries. */
  messageId?: string
  /** Set on Resend so re-deliveries from the dispatcher are idempotent. */
  idempotencyKey?: string
}

export interface SendResult {
  ok: boolean
  providerMessageId?: string
  error?: string
  code?: string
}

function decryptSinkSecret(
  ciphertext: Buffer | null,
  iv: Buffer | null,
  tag: Buffer | null,
  keyVersion: number | null,
): string | null {
  if (!ciphertext || !iv || !tag || keyVersion == null) return null
  return decrypt({ ciphertext, iv, tag, keyVersion })
}

export async function sendViaSmtp(sink: SinkSmtp, args: SendArgs): Promise<SendResult> {
  if (sink.incomplete) {
    return { ok: false, error: 'sink is incomplete (password not set)', code: 'sink-incomplete' }
  }
  let password: string | null = null
  try {
    password = decryptSinkSecret(
      sink.password_ciphertext as Buffer | null,
      sink.password_iv as Buffer | null,
      sink.password_tag as Buffer | null,
      sink.password_key_version,
    )
  } catch (err) {
    return { ok: false, error: 'failed to decrypt SMTP password', code: 'decrypt-failed' }
  }
  if (!password) {
    return { ok: false, error: 'SMTP password not set', code: 'sink-incomplete' }
  }

  // SSRF guard: nodemailer connects straight to host:port, so we must reject
  // private/reserved/internal hosts BEFORE constructing the transport.
  // Otherwise a user could point us at db:5432 / 169.254.169.254 / 127.0.0.1
  // and use connection behavior as a probe.
  try {
    if (await isPrivateHost(sink.host)) {
      return { ok: false, error: 'SMTP host is not allowed', code: 'ssrf-blocked' }
    }
  } catch {
    // Resolution failure → refuse rather than connect.
    return { ok: false, error: 'SMTP host could not be validated', code: 'ssrf-blocked' }
  }

  const transport = nodemailer.createTransport({
    host: sink.host,
    port: sink.port,
    secure: sink.port === 465, // implicit TLS on 465; STARTTLS otherwise
    requireTLS: sink.use_tls,
    auth: { user: sink.username, pass: password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })

  const fromHeader = sink.from_name ? `"${sink.from_name}" <${sink.from_email}>` : sink.from_email

  try {
    const info = await transport.sendMail({
      from: fromHeader,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
      messageId: args.messageId,
    })
    return { ok: true, providerMessageId: info.messageId }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Nodemailer surfaces a `code` on most transport errors (EAUTH, ECONNECTION,
    // ETIMEDOUT, EENVELOPE for bad from/to).
    const code = (err as { code?: string } | null)?.code ?? 'smtp-error'
    // Kill the port-scan oracle: connection-level failures all collapse to a
    // single generic message so the caller can't distinguish refused vs.
    // timed-out vs. unknown-host. The detailed code/message stays server-side.
    if (SMTP_CONNECTION_ERROR_CODES.has(code)) {
      console.error('[email] SMTP connection error', { host: sink.host, port: sink.port, code, message })
      return { ok: false, error: GENERIC_SMTP_CONNECTION_ERROR, code: 'smtp-connection' }
    }
    return { ok: false, error: message, code }
  } finally {
    transport.close()
  }
}

const RESEND_URL = 'https://api.resend.com/emails'

/** Read a fetch Response body as text with a hard byte cap. */
function readCappedResponseText(res: Response): Promise<string> {
  return readCappedText(res.body as ReadableStream<Uint8Array> | null, MAX_ERROR_BODY_BYTES)
}

export async function sendViaResend(sink: SinkResend, args: SendArgs): Promise<SendResult> {
  if (sink.incomplete) {
    return { ok: false, error: 'sink is incomplete (API key not set)', code: 'sink-incomplete' }
  }
  let apiKey: string | null = null
  try {
    apiKey = decryptSinkSecret(
      sink.api_key_ciphertext as Buffer | null,
      sink.api_key_iv as Buffer | null,
      sink.api_key_tag as Buffer | null,
      sink.api_key_key_version,
    )
  } catch {
    return { ok: false, error: 'failed to decrypt Resend API key', code: 'decrypt-failed' }
  }
  if (!apiKey) {
    return { ok: false, error: 'Resend API key not set', code: 'sink-incomplete' }
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
  if (args.idempotencyKey) headers['Idempotency-Key'] = args.idempotencyKey

  const fromHeader = sink.from_name ? `${sink.from_name} <${sink.from_email}>` : sink.from_email
  const body = JSON.stringify({
    from: fromHeader,
    to: [args.to],
    subject: args.subject,
    text: args.text,
    html: args.html,
  })

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      const text = await readCappedResponseText(res).catch(() => '')
      return { ok: false, error: text.slice(0, 500), code: `resend-http-${res.status}` }
    }
    const text = await readCappedResponseText(res).catch(() => '')
    let id: string | undefined
    try {
      id = (JSON.parse(text) as { id?: string }).id
    } catch {
      id = undefined
    }
    return { ok: true, providerMessageId: id }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message, code: 'resend-network' }
  }
}
