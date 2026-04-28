-- Mafiozo — privacy-safe analytics events (F1).
--
-- Append-only event log used by the F3 admin dashboard. Every row is a
-- low-cardinality, metadata-only record. Per-event-type payload schemas
-- are enforced at WRITE time by services/analytics.js#logEvent (allow-list
-- whitelist + recursive dangerous-key strip). Schema does NOT enforce
-- payload shape — JSONB is intentionally flexible so writes never fail
-- the request that triggered them.
--
-- Privacy contract:
--   - payload NEVER carries archive_b64, full final_reveal, voting_history,
--     roleAssignments, votes, prompts, responses, JWTs, passwords, or any
--     secret. logEvent strips these recursively before INSERT.
--   - vote.cast events carry ONLY targetKind ('player'|'skip') — NEVER the
--     voter id, target id, or username.
--   - session.* events carry the room id and counts; they NEVER carry the
--     mafiozo identity, role assignments, or archive content.
--
-- game_id is intentionally NOT a FK to game_sessions(id). Sessions only
-- materialize at FINAL_REVEAL (D1 persistSessionAndStats), but session.*
-- events fire from create_room onward. Treating game_id as a free-form
-- TEXT correlation key avoids losing pre-FINAL_REVEAL events.
--
-- Idempotent. Safe to re-run; tracked in schema_migrations.

CREATE TABLE IF NOT EXISTS analytics_events (
    id           BIGSERIAL PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type   TEXT NOT NULL,
    user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    game_id      TEXT,
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Recent-first scan (admin overview, raw event browser).
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at
  ON analytics_events (created_at DESC);

-- Group-by event_type for taxonomy aggregations.
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_type
  ON analytics_events (event_type);

-- Filtered, time-ordered scan: "show me all session.ended in the last 7d".
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_type_created_at
  ON analytics_events (event_type, created_at DESC);

-- Per-user scan ("how many games played by user X").
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_id
  ON analytics_events (user_id);

-- Per-game correlation (timeline for a specific room id).
CREATE INDEX IF NOT EXISTS idx_analytics_events_game_id
  ON analytics_events (game_id);
