-- Add an admin role to users + promote the existing bootstrap user.
--
-- The app shipped single-user; this introduces a real `is_admin` flag that
-- gates the user-management API (/api/users) and UI (/dashboard/admin/users).
-- Admin routes run as the DB OWNER (they never SET LOCAL ROLE web_role), so
-- they bypass RLS and can see/insert/delete any user row — exactly like the
-- login route already does. That means NO new RLS policy is required here;
-- the `users_self` policy from 0001 still scopes the web_role path correctly.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Promote the oldest (bootstrap) user to admin on upgrade, but only if no admin
-- exists yet. This gives an existing single-user install (the bootstrap user)
-- an admin without any manual SQL. Fresh installs instead get their first admin
-- from the worker bootstrap seeder (seedUser), which now inserts is_admin=true.
UPDATE users SET is_admin = true
WHERE id = (SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin);
