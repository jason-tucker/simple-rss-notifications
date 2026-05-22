import { z } from 'zod'

/**
 * Server-side environment schema. Lazy-validated: parses on first access,
 * not at import time. The lazy pattern matters because Next.js's build
 * imports route files during "Collecting page data," and if env.ts threw
 * at import time the entire production build would fail without real
 * secrets. The runtime container always has them; the build environment
 * does not.
 *
 * Two roles share this module:
 *   - SRN_ROLE=web    (Next.js HTTP server)
 *   - SRN_ROLE=worker (poller/dispatcher loop)
 * Both need the same secrets — same .env, same validation.
 */

const hex64 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)')

const schema = z.object({
  SRN_ROLE: z.enum(['web', 'worker']).default('web'),

  SESSION_SECRET: hex64,
  APP_ENCRYPTION_KEY: hex64,
  DATABASE_URL: z.string().url(),
  PUBLIC_BASE_URL: z.string().url(),

  BOOTSTRAP_USERNAME: z.string().default('tucker'),
  BOOTSTRAP_PASSWORD: z.string().default('admin'),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
})

type Env = z.infer<typeof schema>

let cached: Env | null = null

function parseEnv(): Env {
  const result = schema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(
      `Environment validation failed:\n${issues}\n\nSee .env.example for the required variables.`,
    )
  }
  return result.data
}

/**
 * Proxied access — every property read goes through parseEnv() once on first
 * read, then through the cached object thereafter. Lets us keep the
 * ergonomic `env.SESSION_SECRET` call sites while making validation lazy.
 */
export const env = new Proxy({} as Env, {
  get(_t, prop) {
    if (!cached) cached = parseEnv()
    return cached[prop as keyof Env]
  },
})
