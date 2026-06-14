/**
 * Tiny presentation helpers shared by server and client components.
 * Keep this module dependency-free and side-effect-free so it bundles
 * cleanly into the client (same rule as lib/url.ts).
 */

/** "42s ago" / "3m ago" / "5h ago" / "2d ago" — or "never" when null. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (sec < 0) return `in ${Math.abs(sec)}s`
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

export type SinkType = 'smtp' | 'resend' | 'ntfy' | 'discord_webhook'

/** Human names for the four sink types, used anywhere a type is shown. */
export const SINK_TYPE_LABELS: Record<SinkType, string> = {
  smtp: 'SMTP email',
  resend: 'Resend email',
  ntfy: 'ntfy push',
  discord_webhook: 'Discord',
}

/** Short badge text for a sink type ("SMTP", "RESEND", "NTFY", "DISCORD"). */
export function sinkTypeBadge(type: string): string {
  return type.replace('_webhook', '').toUpperCase()
}
