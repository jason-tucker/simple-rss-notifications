import { BUILD_VERSION, GIT_SHA, RELEASE_URL } from '@/lib/version'

export function Footer() {
  return (
    <footer className="mt-auto border-t border-zinc-200 dark:border-zinc-800 py-3 text-center text-xs text-zinc-500">
      <a
        href={RELEASE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        simple-rss-notifications v{BUILD_VERSION} · {GIT_SHA}
      </a>
    </footer>
  )
}
