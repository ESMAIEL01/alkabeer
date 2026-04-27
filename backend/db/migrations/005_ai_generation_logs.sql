-- Mafiozo — AI generation telemetry. Metadata-only.
--
-- One row per provider attempt (Gemini primary / Gemini fallback /
-- OpenRouter / built-in static). Captures task, source, model, latency,
-- success boolean, short validator/error classification, and a sanitized
-- JSONB metadata blob. Never stores prompt bodies, response bodies,
-- archive_b64, role identities, or any secret.
--
-- Idempotent. Safe to re-run; the migration runner (db/migrate.js) tracks
-- applied filenames in schema_migrations.

CREATE TABLE IF NOT EXISTS ai_generation_logs (
    id                BIGSERIAL PRIMARY KEY,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    task              TEXT NOT NULL,
    source            TEXT NOT NULL,
    model             TEXT,
    latency_ms        INTEGER,
    ok                BOOLEAN NOT NULL,
    validator_reason  TEXT,
    user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
    game_id           TEXT,
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Recent-first scan (admin dashboard, debugging).
CREATE INDEX IF NOT EXISTS idx_ai_generation_logs_created_at
  ON ai_generation_logs (created_at DESC);

-- Group-by for "Gemini archive success rate today" style queries.
CREATE INDEX IF NOT EXISTS idx_ai_generation_logs_task_source
  ON ai_generation_logs (task, source);

-- Quick filter for failures.
CREATE INDEX IF NOT EXISTS idx_ai_generation_logs_ok
  ON ai_generation_logs (ok);
