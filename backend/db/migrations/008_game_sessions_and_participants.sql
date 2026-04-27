-- Mafiozo — game_sessions + game_participants (D1).
--
-- One game_sessions row per completed game (id = roomId). One
-- game_participants row per real player in that game. Combined in a single
-- migration because game_participants references game_sessions.
--
-- Privacy:
--   - archive_b64 and final_reveal carry full hidden truth and may only be
--     read by API paths that gate on game_participants.user_id (D4 archive
--     replay). The D2 history endpoint is a SUMMARY only and must NOT
--     expose these fields.
--   - voting_history JSON is also sensitive (it can hint at private
--     deductions). D2 history must NOT expose it. D4 archive replay does.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS game_sessions (
    id              TEXT PRIMARY KEY,
    host_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    host_mode       TEXT NOT NULL,
    reveal_mode     TEXT NOT NULL,
    custom_config   JSONB,
    outcome         TEXT,
    scenario_title  TEXT,
    archive_b64     TEXT,
    voting_history  JSONB NOT NULL DEFAULT '[]'::jsonb,
    eliminated_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
    final_reveal    JSONB,
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_game_sessions_host_user_id
  ON game_sessions (host_user_id);

CREATE INDEX IF NOT EXISTS idx_game_sessions_ended_at
  ON game_sessions (ended_at DESC);

CREATE INDEX IF NOT EXISTS idx_game_sessions_outcome
  ON game_sessions (outcome);

CREATE TABLE IF NOT EXISTS game_participants (
    game_id                 TEXT REFERENCES game_sessions(id) ON DELETE CASCADE,
    user_id                 INTEGER REFERENCES users(id) ON DELETE CASCADE,
    username                TEXT,
    was_host                BOOLEAN NOT NULL DEFAULT FALSE,
    game_role               TEXT,
    story_character_name    TEXT,
    story_character_role    TEXT,
    eliminated_at_round     INTEGER,
    was_winner              BOOLEAN,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (game_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_game_participants_user_id
  ON game_participants (user_id);

CREATE INDEX IF NOT EXISTS idx_game_participants_game_id
  ON game_participants (game_id);
