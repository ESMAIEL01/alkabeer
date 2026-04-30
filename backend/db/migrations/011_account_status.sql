-- 011_account_status.sql
-- Adds account lifecycle columns to users.
-- Idempotent: all ALTER TABLE uses IF NOT EXISTS or DO $$ checks.
--
-- status values:
--   pending  — registered but not yet approved by an admin
--   approved — active account (default for all pre-existing rows and guests)
--   rejected — admin rejected the registration; cannot log in
--   deleted  — soft-deleted; treated as non-existent for auth purposes
--
-- Backfill: existing rows get DEFAULT 'approved' automatically.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status        TEXT        NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS expires_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by    INTEGER REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'users_status_check' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'deleted'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS users_status_idx     ON users (status);
CREATE INDEX IF NOT EXISTS users_expires_at_idx ON users (expires_at) WHERE expires_at IS NOT NULL;
