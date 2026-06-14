import { redirect } from 'next/navigation'
import Link from 'next/link'
import { readSessionCookie } from '@/lib/auth/session'
import { SinkForm } from '@/components/SinkForm'
import { PageHeader } from '@/components/ui'
import { SINK_TYPE_LABELS, type SinkType } from '@/lib/format'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Add sink' }

const TYPES: Array<{ type: SinkType; name: string; desc: string }> = [
  { type: 'smtp', name: 'Email — SMTP', desc: 'Send through your own mail server or provider mailbox.' },
  { type: 'resend', name: 'Email — Resend', desc: 'Send through the Resend API with an API key.' },
  { type: 'ntfy', name: 'Push — ntfy', desc: 'Instant push notifications to your phone via the ntfy app.' },
  { type: 'discord_webhook', name: 'Discord', desc: 'Post new items to a channel via webhook.' },
]

export default async function NewSinkPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>
}) {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  const params = await searchParams
  const type = TYPES.find((t) => t.type === params.type)?.type

  // No type picked yet → show the chooser.
  if (!type) {
    return (
      <div className="mx-auto max-w-xl space-y-6">
        <PageHeader title="Add sink" description="Pick where notifications should be delivered." />
        <div className="grid gap-3 sm:grid-cols-2">
          {TYPES.map((t) => (
            <Link
              key={t.type}
              href={`/dashboard/sinks/new?type=${t.type}`}
              className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 transition-colors hover:border-zinc-600"
            >
              <div className="font-medium text-zinc-100">{t.name}</div>
              <div className="mt-1 text-sm text-zinc-500">{t.desc}</div>
            </Link>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader
        title={`Add ${SINK_TYPE_LABELS[type]} sink`}
        description={TYPES.find((t) => t.type === type)?.desc}
      />
      <SinkForm mode="new" type={type} />
    </div>
  )
}
