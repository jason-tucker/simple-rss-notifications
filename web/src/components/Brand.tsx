import Image from 'next/image'

/**
 * Brand mark — gradient ring "e" speech bubble from the Euphoric family
 * (Euphoric FM, Euphoric Media, Euphoric Notify). Used in the header and
 * on auth pages.
 *
 * Renders as a square; pass `size` for any pixel dimension. The wordmark
 * is rendered alongside when `withWordmark` is true (default).
 */
export function Brand({
  size = 32,
  withWordmark = true,
  className,
}: {
  size?: number
  withWordmark?: boolean
  className?: string
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <Image
        src="/logo.png"
        alt="Euphoric Notify"
        width={size}
        height={size}
        priority
        className="rounded"
      />
      {withWordmark && (
        <span className="font-semibold tracking-tight">
          <span className="bg-gradient-to-r from-sky-400 via-violet-400 to-fuchsia-400 bg-clip-text text-transparent">Euphoric</span>
          <span className="text-zinc-100"> Notify</span>
        </span>
      )}
    </span>
  )
}
