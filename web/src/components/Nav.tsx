'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cx } from '@/components/ui'

const LINKS: Array<{ href: string; label: string; exact?: boolean }> = [
  { href: '/', label: 'Overview', exact: true },
  { href: '/dashboard/feeds', label: 'Feeds' },
  { href: '/dashboard/routes', label: 'Routes' },
  { href: '/dashboard/sinks', label: 'Sinks' },
  { href: '/dashboard/activity', label: 'Activity' },
]

const ADMIN_LINK = { href: '/dashboard/admin/users', label: 'Users' }

export function Nav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname()
  const links = isAdmin ? [...LINKS, ADMIN_LINK] : LINKS
  return (
    <nav className="-mx-1 flex flex-wrap items-center gap-1 overflow-x-auto">
      {links.map((l) => {
        const active = l.exact ? pathname === l.href : pathname.startsWith(l.href)
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? 'page' : undefined}
            className={cx(
              'rounded-md px-3 py-1.5 text-sm transition-colors',
              active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100',
            )}
          >
            {l.label}
          </Link>
        )
      })}
    </nav>
  )
}
