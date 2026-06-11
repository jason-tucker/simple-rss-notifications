import Link from 'next/link'
import type { ComponentProps, ReactNode } from 'react'

/**
 * Shared UI primitives — the entire design system in one file.
 *
 * No 'use client' directive on purpose: nothing here uses hooks or state,
 * so server components can render these directly, and client components
 * pull them into their own bundle when they attach handlers.
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/* ------------------------------------------------------------------ */
/* Buttons                                                            */
/* ------------------------------------------------------------------ */

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-md transition-colors ' +
  'disabled:pointer-events-none disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400'

const BUTTON_VARIANTS = {
  primary: 'bg-zinc-100 font-medium text-zinc-900 hover:bg-white',
  ghost: 'border border-zinc-700 text-zinc-200 hover:bg-zinc-800',
  danger: 'border border-red-900 text-red-300 hover:bg-red-950',
} as const

const BUTTON_SIZES = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-4 py-2 text-sm',
} as const

export type ButtonVariant = keyof typeof BUTTON_VARIANTS
export type ButtonSize = keyof typeof BUTTON_SIZES

export function Button({
  variant = 'ghost',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ComponentProps<'button'> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      type={type}
      {...rest}
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
    />
  )
}

export function ButtonLink({
  variant = 'ghost',
  size = 'md',
  className,
  ...rest
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <Link
      {...rest}
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Form controls                                                      */
/* ------------------------------------------------------------------ */

const CONTROL_CLS =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ' +
  'placeholder:text-zinc-600 outline-none focus:border-zinc-400'

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return <input {...rest} className={cx(CONTROL_CLS, className)} />
}

export function Select({ className, ...rest }: ComponentProps<'select'>) {
  return <select {...rest} className={cx(CONTROL_CLS, className)} />
}

/** Label + control + optional hint, stacked. Wrap any Input/Select in it. */
export function Field({
  label,
  hint,
  optional,
  children,
}: {
  label: string
  hint?: ReactNode
  optional?: boolean
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="text-sm text-zinc-400">
        {label}
        {optional && <span className="text-zinc-600"> (optional)</span>}
      </span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  )
}

/** A checkbox with its label on one line. */
export function CheckboxRow({
  label,
  className,
  ...rest
}: ComponentProps<'input'> & { label: ReactNode }) {
  return (
    <label className={cx('flex items-center gap-2 text-sm text-zinc-300', className)}>
      <input type="checkbox" {...rest} className="accent-zinc-300" />
      <span>{label}</span>
    </label>
  )
}

/* ------------------------------------------------------------------ */
/* Surfaces & status                                                  */
/* ------------------------------------------------------------------ */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-lg border border-zinc-800 bg-zinc-900/60', className)}>{children}</div>
}

const BADGE_TONES = {
  neutral: 'bg-zinc-800 text-zinc-300',
  ok: 'bg-emerald-950 text-emerald-300 ring-1 ring-inset ring-emerald-900',
  warn: 'bg-amber-950 text-amber-300 ring-1 ring-inset ring-amber-900',
  danger: 'bg-red-950 text-red-300 ring-1 ring-inset ring-red-900',
  info: 'bg-sky-950 text-sky-300 ring-1 ring-inset ring-sky-900',
} as const

export type BadgeTone = keyof typeof BADGE_TONES

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: BadgeTone
  className?: string
  children: ReactNode
}) {
  return (
    <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-xs', BADGE_TONES[tone], className)}>
      {children}
    </span>
  )
}

/** Colored status dot for at-a-glance health (feeds list, etc.). */
export function Dot({ tone }: { tone: 'ok' | 'danger' | 'off' }) {
  const color = tone === 'ok' ? 'bg-emerald-400' : tone === 'danger' ? 'bg-red-400' : 'bg-zinc-600'
  return <span aria-hidden className={cx('inline-block h-2 w-2 shrink-0 rounded-full', color)} />
}

/* ------------------------------------------------------------------ */
/* Page scaffolding                                                   */
/* ------------------------------------------------------------------ */

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-zinc-100">{title}</h1>
        {description && <p className="mt-1 max-w-prose text-sm text-zinc-400">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  )
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string
  hint?: ReactNode
  action?: ReactNode
}) {
  return (
    <Card className="flex flex-col items-center gap-2 p-10 text-center">
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      {hint && <p className="max-w-md text-sm text-zinc-500">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </Card>
  )
}

/** Amber / red callout banners for warnings ("incomplete sinks", "feeds failing"). */
export function Callout({
  tone,
  children,
}: {
  tone: 'warn' | 'danger'
  children: ReactNode
}) {
  const cls =
    tone === 'warn'
      ? 'border-amber-900 bg-amber-950/60 text-amber-200'
      : 'border-red-900 bg-red-950/60 text-red-200'
  return <div className={cx('rounded-lg border px-4 py-3 text-sm', cls)}>{children}</div>
}
