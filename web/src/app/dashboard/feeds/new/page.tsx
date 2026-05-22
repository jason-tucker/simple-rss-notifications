import { redirect } from 'next/navigation'
import Link from 'next/link'
import { readSessionCookie } from '@/lib/auth/session'
import { NewFeedForm } from '@/components/NewFeedForm'

export const dynamic = 'force-dynamic'

export default async function NewFeedPage() {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">New feed</h1>
        <p className="mt-1 text-sm text-zinc-500">
          <Link href="/dashboard/feeds" className="hover:text-zinc-300">← back to feeds</Link>
        </p>
      </header>
      <NewFeedForm />
    </div>
  )
}
