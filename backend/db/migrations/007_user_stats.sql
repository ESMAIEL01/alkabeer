-- Mafiozo — user_stats (D1).
--
-- Derived counter table. One row per user. Updated by
-- GameManager.persistSessionAndStats() when a game reaches FINAL_REVEAL.
-- Legacy stat columns on `users` (wins, survival, accurately_voted,
-- mafiozo_count, current_title) are intentionally left in place but
-- DEPRECATED in favor of this normalized table. No backfill of historical
-- games is attempted — counters start at zero from D1 forward.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS user_stats (
    user_id                  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    games_played             INTEGER NOT NULL DEFAULT 0,
    wins                     INTEGER NOT NULL DEFAULT 0,
    losses                   INTEGER NOT NULL DEFAULT 0,
    times_mafiozo            INTEGER NOT NULL DEFAULT 0,
    times_innocent           INTEGER NOT NULL DEFAULT 0,
    times_obvious_suspect    INTEGER NOT NULL DEFAULT 0,
    total_survival_rounds    INTEGER NOT NULL DEFAULT 0,
    favorite_mode            TEXT,
    last_played_at           TIMESTAMPTZ
);
