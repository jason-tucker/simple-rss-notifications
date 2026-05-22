-- Hand-written follow-up to the Drizzle-generated schema.
-- Adds Postgres RLS and two roles (web_role / worker_role) used by the
-- application layer's lib/db/withUser.ts to enforce per-user data isolation
-- with SET LOCAL ROLE + SET LOCAL app.current_user_id at transaction start.

-- ── Roles (idempotent — CREATE ROLE fails if exists, DO block swallows that) ─
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_role') THEN
    CREATE ROLE web_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worker_role') THEN
    CREATE ROLE worker_role NOLOGIN BYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint

-- The connecting login user (POSTGRES_USER from .env) must be able to
-- SWITCH INTO these roles via SET LOCAL ROLE inside a transaction.
-- Wrapped in DO so a re-run on an already-granted role is a no-op.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members am
    JOIN pg_roles m ON m.oid = am.member
    JOIN pg_roles r ON r.oid = am.roleid
    WHERE m.rolname = current_user AND r.rolname = 'web_role'
  ) THEN
    EXECUTE format('GRANT web_role TO %I', current_user);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members am
    JOIN pg_roles m ON m.oid = am.member
    JOIN pg_roles r ON r.oid = am.roleid
    WHERE m.rolname = current_user AND r.rolname = 'worker_role'
  ) THEN
    EXECUTE format('GRANT worker_role TO %I', current_user);
  END IF;
END $$;
--> statement-breakpoint

-- Both roles need read/write on the application tables. Future tables
-- created by later migrations must also explicitly grant — there's no
-- ALTER DEFAULT PRIVILEGES set up (intentional, to force conscious choices).
GRANT USAGE ON SCHEMA public TO web_role, worker_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, web_sessions, audit_log, rate_limit_buckets, worker_heartbeats, app_meta TO web_role, worker_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO web_role, worker_role;
--> statement-breakpoint

-- ── Row Level Security ──────────────────────────────────────────────────────
-- web_role is subject to RLS. worker_role has BYPASSRLS so background jobs
-- (dispatching, polling, bootstrap) see all rows. The owner (POSTGRES_USER)
-- is the table owner and also bypasses RLS by default — that's fine because
-- the application layer always SET LOCAL ROLE before queries; the owner
-- identity exists only to run migrations and the bootstrap seeder.

ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_sessions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log     ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- A user can read/write only their own row.
DROP POLICY IF EXISTS users_self ON users;
CREATE POLICY users_self ON users
  USING (id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint

-- A user sees only their own sessions.
DROP POLICY IF EXISTS web_sessions_self ON web_sessions;
CREATE POLICY web_sessions_self ON web_sessions
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint

-- A user reads only audit rows they're the actor of (admins later get a
-- super-policy in a future migration). actor_user_id can be NULL when a
-- user is deleted (ON DELETE SET NULL) — those rows become invisible to
-- everyone-but-superuser, which is the right default.
DROP POLICY IF EXISTS audit_log_actor ON audit_log;
CREATE POLICY audit_log_actor ON audit_log
  USING (actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
