import type { Config } from 'drizzle-kit'

/**
 * Drizzle Kit config — only used at developer-time for generating migrations
 * (`pnpm db:generate`). Runtime migrations are applied by `src/lib/db/migrate.ts`,
 * which the worker invokes on boot (web does NOT run migrations — only the
 * worker does, so two replicas of web never race against the same migration).
 */
export default {
  schema: './src/lib/db/schema/*',
  out: './src/lib/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://srn:srn@localhost:5432/srn',
  },
  strict: true,
  verbose: true,
} satisfies Config
