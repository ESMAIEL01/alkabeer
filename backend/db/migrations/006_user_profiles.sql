-- Mafiozo — user_profiles (D1).
--
-- Per-user profile data: display name, avatar URL, written bio, AI-rewritten
-- bio. Lives separately from `users` so authentication stays minimal and
-- profile edits never touch the auth/credential row.
--
-- Idempotent. Tracked by db/migrate.js via schema_migrations.

CREATE TABLE IF NOT EXISTS user_profiles (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name   TEXT,
    avatar_url     TEXT,
    bio            TEXT,
    ai_bio         TEXT,
    ai_bio_source  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_updated_at
  ON user_profiles (updated_at DESC);
