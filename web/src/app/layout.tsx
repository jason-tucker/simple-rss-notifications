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
      <body className="bg-zinc-950 text-zinc-100 antialiased">
        <main className="flex-1 max-w-3xl mx-auto w-full px-6 py-10">{children}</main>
        <Footer />
      </body>
    </html>
  )
}
