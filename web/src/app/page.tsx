import { BUILD_VERSION } from '@/lib/version'

export default function HomePage() {
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-semibold">simple-rss-notifications</h1>
      <p className="text-zinc-400">
        RSS → email / ntfy bridge. Configure everything in the UI — no server-side
        config files, no restarts on change.
      </p>
      <p className="text-zinc-500 text-sm">
        v{BUILD_VERSION} — scaffold. Login + dashboard land in PR3.
      </p>
    </div>
  )
}
