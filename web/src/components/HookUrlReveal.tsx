'use client'

import { useState } from 'react'
import { Button, Callout } from '@/components/ui'

/**
 * Shows a freshly minted webhook URL. The server only stores a hash, so
 * this is the one and only time the full URL can be displayed.
 */
export function HookUrlReveal({ url, onDone, doneLabel = 'Done' }: { url: string; onDone: () => void; doneLabel?: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="space-y-3">
      <Callout tone="warn">
        <p className="text-sm">
          Copy this URL now — it is shown only once. Anyone with it can post notifications to this feed.
          If you lose it, use &ldquo;Regenerate token&rdquo; to issue a new one.
        </p>
      </Callout>
      <input
        readOnly
        aria-label="Webhook URL"
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100"
      />
      <div className="flex gap-2">
        <Button type="button" variant="primary" size="sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy URL'}
        </Button>
        <Button type="button" size="sm" onClick={onDone}>{doneLabel}</Button>
      </div>
    </div>
  )
}
