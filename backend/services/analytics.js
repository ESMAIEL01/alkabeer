/**
 * Analytics — AI generation logging.
 *
 * Writes one metadata-only row per AI provider attempt to the
 * ai_generation_logs table (migration 005). The default logger
 * uses a lazy-required DB pool so test harnesses can require this
 * module without booting Postgres.
 *
 * Hard guarantees:
 *   - logAiGeneration NEVER throws (DB failure → console.warn + return).
 *   - logAiGeneration NEVER blocks the calling code's response chain;
 *     callers should fire-and-forget rather than await.
 *   - Stored metadata never includes prompts, responses, archive_b64,
 *     role data, JWTs, or any secret. Dangerous keys are stripped
 *     recursively before the INSERT.
 *
 * Public API:
 *   logAiGeneration(args)             — default logger, lazy-binds DB
 *   createAiLogger({ query })         — factory for tests / DI
 *   sanitizeAiMetadata(input)         — pure helper, exported for tests
 *   normalizeAiLogInput(input)        — pure helper, exported for tests
 *   clampSafeText(value, maxLength)   — pure helper, exported for tests
 */

const MAX_TASK_LEN = 80;
const MAX_SOURCE_LEN = 80;
const MAX_MODEL_LEN = 120;
const MAX_VALIDATOR_REASON_LEN = 300;
const MAX_GAME_ID_LEN = 80;
const MAX_METADATA_STR_LEN = 300;
const MAX_METADATA_BYTES = 4 * 1024;     // 4 KB after JSON.stringify
const MAX_METADATA_DEPTH = 6;            // bail on cycles / extreme nesting

// Recursively stripped at any depth. Anything that could carry user prompt
// content, raw model output, full archive bodies, PII, or secrets.
const DANGEROUS_KEYS = new Set([
  // model I/O
  'prompt', 'rawPrompt', 'systemPrompt', 'userPrompt',
  'messages', 'response', 'rawResponse', 'text', 'output',
  // gameplay payloads
  'archive_b64',
  // credentials
  'token', 'jwt', 'apiKey', 'api_key', 'key', 'secret', 'password',
  'authorization', 'headers',
  // env vars
  'databaseUrl', 'DATABASE_URL',
  'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'JWT_SECRET',
]);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Coerce to string; clamp to maxLength chars (no UTF-16 surrogate care —
 * inputs are all short ASCII labels or short Arabic strings, both safe).
 * Returns null if input is null/undefined.
 */
function clampSafeText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (s.length <= maxLength) return s;
  return s.slice(0, maxLength);
}

/**
 * Recursively strip dangerous keys, clamp string values, drop unsupported
 * types. Returns a new object — never mutates input. Bails on cycles via
 * depth limit. If the resulting JSON is too large, replaces with a small
 * truncation marker.
 */
function sanitizeAiMetadata(input) {
  if (input === null || input === undefined) return {};
  if (typeof input !== 'object') return {};

  function clean(v, depth) {
    if (depth > MAX_METADATA_DEPTH) return null;
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') return clampSafeText(v, MAX_METADATA_STR_LEN);
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v;
    if (Array.isArray(v)) {
      return v
        .map(item => clean(item, depth + 1))
        .filter(x => x !== undefined);
    }
    if (typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) {
        if (DANGEROUS_KEYS.has(k)) continue;
        const cleaned = clean(v[k], depth + 1);
        if (cleaned !== undefined) out[k] = cleaned;
      }
      return out;
    }
    return null;
  }

  const cleaned = clean(input, 0);
  const out = (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned)) ? cleaned : {};

  // Hard byte budget. If exceeded, swap for a small marker rather than
  // truncating mid-key (which would produce invalid JSON).
  let serialized;
  try {
    serialized = JSON.stringify(out);
  } catch {
    return { _truncated: 'metadata_unserializable' };
  }
  if (serialized.length > MAX_METADATA_BYTES) {
    return { _truncated: 'metadata_too_large', _bytes: serialized.length };
  }
  return out;
}

/**
 * Coerce + clamp every field on an AI-log input record. Resilient to
 * null/undefined input. Always returns a complete record with safe defaults.
 */
function normalizeAiLogInput(input) {
  const i = input || {};
  return {
    task: clampSafeText(i.task, MAX_TASK_LEN) || 'unknown',
    source: clampSafeText(i.source, MAX_SOURCE_LEN) || 'unknown',
    model: i.model === null || i.model === undefined
      ? null
      : clampSafeText(i.model, MAX_MODEL_LEN),
    latencyMs: Number.isFinite(i.latencyMs)
      ? Math.max(0, Math.trunc(i.latencyMs))
      : null,
    ok: !!i.ok,
    validatorReason: i.validatorReason === null || i.validatorReason === undefined
      ? null
      : clampSafeText(i.validatorReason, MAX_VALIDATOR_REASON_LEN),
    userId: Number.isFinite(i.userId) ? Math.trunc(i.userId) : null,
    gameId: i.gameId === null || i.gameId === undefined
      ? null
      : clampSafeText(i.gameId, MAX_GAME_ID_LEN),
    metadata: sanitizeAiMetadata(i.metadata),
  };
}

// ---------------------------------------------------------------------------
// Logger factory + default logger
// ---------------------------------------------------------------------------

/**
 * Construct an AI logger bound to a specific query function. Tests inject
 * a fake query; production uses the lazy default below.
 */
function createAiLogger({ query }) {
  if (typeof query !== 'function') {
    throw new TypeError('createAiLogger requires { query: function }');
  }
  return async function logAiGeneration(args) {
    try {
      const n = normalizeAiLogInput(args);
      await query(
        `INSERT INTO ai_generation_logs
          (task, source, model, latency_ms, ok, validator_reason, user_id, game_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [n.task, n.source, n.model, n.latencyMs, n.ok, n.validatorReason, n.userId, n.gameId, JSON.stringify(n.metadata)]
      );
    } catch (err) {
      // Never throw, never block. Keep the warning short — no payload leak.
      const code = err && err.code ? String(err.code) : null;
      const msg = err && err.message ? String(err.message).slice(0, 120) : 'unknown';
      console.warn('[ai-log] insert failed:', code || msg);
    }
  };
}

let _defaultLogger = null;
function getDefaultLogger() {
  if (_defaultLogger) return _defaultLogger;
  // Lazy require: tests that import this module must NOT trigger DB boot.
  const { query } = require('../database');
  _defaultLogger = createAiLogger({ query });
  return _defaultLogger;
}

/**
 * Default logger for production code. Fire-and-forget:
 *   logAiGeneration({...}).catch(() => {});
 * (.catch is defensive; the function never rejects today.)
 */
async function logAiGeneration(args) {
  try {
    const fn = getDefaultLogger();
    return await fn(args);
  } catch {
    // Setup error (e.g. DB module missing in an unusual environment).
    // Swallow — caller must never see this.
    console.warn('[ai-log] default logger setup failed');
  }
}

module.exports = {
  logAiGeneration,
  createAiLogger,
  sanitizeAiMetadata,
  normalizeAiLogInput,
  clampSafeText,
};
