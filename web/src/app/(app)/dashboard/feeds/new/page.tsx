import { redirect } from 'next/navigation'
import { readSessionCookie } from '@/lib/auth/session'
import { NewFeedForm } from '@/components/NewFeedForm'
import { PageHeader } from '@/components/ui'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Add feed' }

export default async function NewFeedPage() {
  const session = await readSessionCookie()
  if (!session) redirect('/login')

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader title="Add feed" description="Point at an RSS or Atom URL and the worker starts watching it." />
      <NewFeedForm />
    </div>
  )
}
