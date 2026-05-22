import type { Metadata } from 'next'
import { Footer } from '@/components/Footer'
import './globals.css'

export const metadata: Metadata = {
  title: 'simple-rss-notifications',
  description: 'RSS → email / ntfy notification bridge',
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
