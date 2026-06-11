'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui'

export function LogoutButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
        router.replace('/login')
      }}
    >
      {busy ? 'Signing out…' : 'Log out'}
    </Button>
  )
}
