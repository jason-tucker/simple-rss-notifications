import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from './client'

/**
 * Notify the worker that config the poller/dispatcher cares about has
 * changed. Cheap fire-and-forget — failures are non-fatal (the worker
 * has a periodic safety-net poll as a fallback).
 *
 *   - 'feeds_changed' fires after a feed/route/destination CRUD so the
 *     poller picks up the new shape on its next tick (which the NOTIFY
 *     wakes immediately).
 *   - 'dispatches_changed' fires after a retry so the dispatcher
 *     considers the newly-pending row right away instead of waiting up
 *     to IDLE_SLEEP_MS.
 *
 * The payload is short on purpose — Postgres caps NOTIFY payloads at
 * 8 KiB. We never put PII or secrets in it.
 */

export async function notifyFeedsChanged(): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_notify('feeds_changed', '')`)
  } catch {
    // Worker's safety-net poll will catch the change within IDLE_SLEEP_MS.
  }
}

export async function notifyDispatchesChanged(): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_notify('dispatches_changed', '')`)
  } catch {
    /* swallow */
  }
}
