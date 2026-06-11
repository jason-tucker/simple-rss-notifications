import type { Metadata } from 'next'
import { Footer } from '@/components/Footer'
import './globals.css'

/**
 * Product brand is "Euphoric Notify" (sibling to Euphoric FM / Euphoric Media).
 * The repo / package / Docker images stay `simple-rss-notifications` per the
 * brand-vs-codebase split — only user-visible surfaces show the product name.
 */
export const metadata: Metadata = {
  title: {
    default: 'Euphoric Notify',
    template: '%s · Euphoric Notify',
  },
  description: 'RSS → email & ntfy notification bridge. Part of the Euphoric family.',
  applicationName: 'Euphoric Notify',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      {/* Each segment owns its own chrome: the (app) group renders the nav
          shell, login/password render a centered card. The body is a flex
          column (globals.css) so the footer stays pinned to the bottom. */}
      <body className="bg-zinc-950 text-zinc-100 antialiased">
        {children}
        <Footer />
      </body>
    </html>
  )
}
