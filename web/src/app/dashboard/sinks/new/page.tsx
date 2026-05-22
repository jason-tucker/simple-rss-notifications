import { redirect } from 'next/navigation'
import Link from 'next/link'
import { readSessionCookie } from '@/lib/auth/session'
import { SinkForm } from '@/components/SinkForm'

export const dynamic = 'force-dynamic'

export default async function NewSinkPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>
}) {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  const params = await searchParams
  const type: 'smtp' | 'resend' | 'ntfy' | 'discord_webhook' =
    params.type === 'resend' ? 'resend'
    : params.type === 'ntfy' ? 'ntfy'
    : params.type === 'discord_webhook' ? 'discord_webhook'
    : 'smtp'

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">New {type.toUpperCase()} sink</h1>
        <p className="mt-1 text-sm text-zinc-500">
          <Link href="/dashboard/sinks" className="hover:text-zinc-300">← back to sinks</Link>
        </p>
      </header>
      <SinkForm mode="new" type={type} />
    </div>
  )
}
