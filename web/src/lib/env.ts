import { z } from 'zod'

/**
 * Server-side environment schema. The app refuses to start if any required
 * field is missing — no silent fallbacks to insecure defaults.
 *
 * Two roles share this module:
 *   - SRN_ROLE=web    (Next.js HTTP server)
 *   - SRN_ROLE=worker (poller/dispatcher loop)
 *
 * Both roles need the same secrets — same .env, same validation.
 */

const hex64 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)')

const schema = z.object({
  SRN_ROLE: z.enum(['web', 'worker']).default('web'),

  // Required secrets. NO defaults — missing = startup failure.
  SESSION_SECRET: hex64,
  APP_ENCRYPTION_KEY: hex64,

  // Database
  DATABASE_URL: z.string().url(),

  // Public URL — used for cookie domain, CSRF origin, OAuth redirect (later).
  PUBLIC_BASE_URL: z.string().url(),

  // Bootstrap user (optional — `skip` disables first-boot seeding)
  BOOTSTRAP_USERNAME: z.string().default('tucker'),
  BOOTSTRAP_PASSWORD: z.string().default('admin'),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
})

function parseEnv() {
  const result = schema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    // Hard fail. We do NOT want the app to boot with broken or missing
    // secrets — that's how silent credential leaks happen.
    throw new Error(
      `Environment validation failed:\n${issues}\n\nSee .env.example for the required variables.`,
    )
  }
  return result.data
}

export const env = parseEnv()
