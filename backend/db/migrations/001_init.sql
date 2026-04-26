-- AlKabeer initial schema
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    username        TEXT UNIQUE NOT NULL,
    password_hash   TEXT,
    is_guest        BOOLEAN NOT NULL DEFAULT FALSE,
    wins            INTEGER NOT NULL DEFAULT 0,
    survival        INTEGER NOT NULL DEFAULT 0,
    accurately_voted INTEGER NOT NULL DEFAULT 0,
    mafiozo_count   INTEGER NOT NULL DEFAULT 0,
    current_title   TEXT NOT NULL DEFAULT 'Beginner',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
CREATE INDEX IF NOT EXISTS idx_users_is_guest ON users (is_guest);

CREATE TABLE IF NOT EXISTS scenario_drafts (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT,
    content     TEXT,
    archive_b64 TEXT,
    clues       JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scenario_drafts_user_id ON scenario_drafts (user_id);

CREATE TABLE IF NOT EXISTS marketplace (
    id          SERIAL PRIMARY KEY,
    author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title       TEXT,
    description TEXT,
    content     TEXT,
    upvotes     INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketplace_author_id ON marketplace (author_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_upvotes ON marketplace (upvotes DESC);

-- Optional: snapshot table so games survive backend restarts on free tier.
CREATE TABLE IF NOT EXISTS game_snapshots (
    room_id     TEXT PRIMARY KEY,
    state       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_game_snapshots_updated_at ON game_snapshots (updated_at DESC);
