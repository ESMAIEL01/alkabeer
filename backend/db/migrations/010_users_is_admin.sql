-- Mafiozo — admin flag for users (F2).
--
-- Adds a single boolean column. Bootstrap is direct SQL only — no API
-- endpoint grants admin (anti-escalation contract). Rollback note: dropping
-- the column would break the admin middleware; if reverting, also revert
-- middleware/admin.js and routes/admin.js.
--
-- Idempotent. Tracked in schema_migrations.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index. Only the small set of admins is indexed; non-admin rows
-- are not paid for in the index. Used by admin-list endpoints in F3.
CREATE INDEX IF NOT EXISTS idx_users_is_admin
  ON users (is_admin) WHERE is_admin = TRUE;
