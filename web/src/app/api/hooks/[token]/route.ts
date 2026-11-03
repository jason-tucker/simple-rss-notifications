import type { NextRequest } from 'next/server'
import { clientIp } from '@/lib/ratelimit'
import { findWebhookFeed, ingestItem } from '@/lib/hooks/ingest'
import { handleHook } from '@/lib/hooks/handler'

/**
 * PUBLIC ingest endpoint (middleware lets /api/hooks/<token-shaped> through).
 * The only credential is the unguessable token in the path. All logic
 * (token handling, in-memory throttling, 64 KB body cap, normalization)
 * lives in lib/hooks/handler.ts. The limits are in-memory and per process,
 * a deliberate deviation from CLAUDE.md rule 11 (see lib/hooks/rateLimit.ts).
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function handle(req: NextRequest, route: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await route.params
  return handleHook(req, token, clientIp(req), { findFeed: findWebhookFeed, ingest: ingestItem })
}

export const POST = handle
export const PUT = handle
