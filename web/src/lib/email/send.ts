import 'server-only'
import nodemailer from 'nodemailer'
import type { SinkSmtp, SinkResend } from '@/lib/db/schema'
import { decrypt } from '@/lib/crypto/aead'

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
  text?: string
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
    // ETIMEDOUT, EENVELOPE for bad from/to). Pull it through verbatim.
    const code = (err as { code?: string } | null)?.code ?? 'smtp-error'
    return { ok: false, error: message, code }
  } finally {
    transport.close()
  }
}

const RESEND_URL = 'https://api.resend.com/emails'

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
      const text = await res.text().catch(() => '')
      return { ok: false, error: text.slice(0, 500), code: `resend-http-${res.status}` }
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string }
    return { ok: true, providerMessageId: data.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message, code: 'resend-network' }
  }
}
