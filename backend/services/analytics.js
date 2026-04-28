/**
 * Analytics — AI generation logging (C1) + privacy-safe events log (F1).
 *
 * Two append-only logs share the same module:
 *
 *   1. ai_generation_logs (C1, migration 005) — one row per AI provider
 *      attempt. Written via logAiGeneration / createAiLogger.
 *
 *   2. analytics_events (F1, migration 009) — privacy-safe event taxonomy
 *      written by the game state machine + REST routes. Per-event-type
 *      payload allow-list enforced at write time so a careless caller
 *      cannot smuggle a secret in via a typo'd payload.
 *
 * Hard guarantees (apply to BOTH loggers):
 *   - The logger NEVER throws (DB failure → console.warn + return).
 *   - The logger NEVER blocks the calling code's response chain;
 *     callers should fire-and-forget rather than await.
 *   - Stored payloads/metadata never include prompts, responses,
 *     archive_b64, role data, JWTs, votes, or any secret. Dangerous keys
 *     are stripped recursively before the INSERT.
 *
 * Public API:
 *   // C1
 *   logAiGeneration(args)             — default logger, lazy-binds DB
 *   createAiLogger({ query })         — factory for tests / DI
 *   // F1
 *   logEvent(args)                    — default logger, lazy-binds DB
 *   createEventLogger({ query })      — factory for tests / DI
 *   EVENT_TYPES                       — frozen taxonomy (allow-list)
 *   EVENT_PAYLOAD_ALLOWLIST           — per-event-type payload key allow-list
 *   normalizeEventInput(input)        — pure helper, exported for tests
 *   sanitizeEventPayload(t, p)        — pure helper, exported for tests
 *   // pure helpers shared by both
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

// ===========================================================================
// F1 — privacy-safe event log
// ===========================================================================

const MAX_EVENT_TYPE_LEN = 64;
const MAX_PAYLOAD_BYTES = 4 * 1024;     // 4 KB after JSON.stringify

/**
 * Frozen event taxonomy. Any event_type NOT in this set is rejected at
 * normalize time and a single 'event.unknown_type' fallback row is written
 * with the original event_type clamped into payload.attemptedType. This
 * ensures hook-point typos never blow up the calling code AND never silently
 * write arbitrary event_type values.
 */
const EVENT_TYPES = Object.freeze({
  SESSION_CREATED:                  'session.created',
  SESSION_ARCHIVE_SEALED:           'session.archive_sealed',
  SESSION_PHASE_TRANSITION:         'session.phase_transition',
  SESSION_ENDED:                    'session.ended',
  VOTE_CAST:                        'vote.cast',
  VOTE_EARLY_CLOSE:                 'vote.early_close',
  FEATURE_READY_TO_VOTE_USED:       'feature.ready_to_vote_used',
  FEATURE_VOTE_EXTENSION_ACTIVATED: 'feature.vote_extension_activated',
  AI_CALL:                          'ai.call',
  AUTH_GUEST_CREATED:               'auth.guest_created',
  AUTH_USER_REGISTERED:             'auth.user_registered',
  AUTH_USER_LOGIN:                  'auth.user_login',
  PROFILE_BIO_AI_REQUESTED:         'profile.bio_ai_requested',
  PROFILE_UPDATED:                  'profile.updated',
  ARCHIVE_REPLAY_OPENED:            'archive.replay_opened',
  ERROR_PHASE_MACHINE:              'error.phase_machine',
  EVENT_UNKNOWN_TYPE:               'event.unknown_type',
});

const KNOWN_EVENT_TYPES = new Set(Object.values(EVENT_TYPES));

/**
 * Per-event-type payload allow-list. Only listed keys are kept; any
 * unknown key is dropped (after the recursive dangerous-key strip).
 *
 * Hard rules:
 *   - vote.cast carries ONLY targetKind ('player'|'skip'). NEVER voter id,
 *     target id, or username.
 *   - session.* events carry the room id (game_id is the correlation key)
 *     and counters/labels — never the mafiozo identity, never role data.
 *   - ai.call mirrors a row in ai_generation_logs for analytics convenience;
 *     it carries only short labels + booleans + integers.
 *   - profile.bio_ai_requested carries source + boolean; NEVER the rawIdea
 *     or the generated bio.
 *   - archive.replay_opened carries booleans + the round count; the
 *     participants check has already passed by the time we log.
 */
const EVENT_PAYLOAD_ALLOWLIST = Object.freeze({
  'session.created':                   ['mode', 'roleRevealMode', 'isCustom', 'playerCount', 'mafiozoCount', 'clueCount'],
  'session.archive_sealed':            ['archiveSource', 'isCustom', 'playerCount', 'mafiozoCount', 'clueCount'],
  'session.phase_transition':          ['phase', 'previousPhase', 'round', 'durationSeconds'],
  'session.ended':                     ['outcome', 'rounds', 'durationSec', 'isCustom', 'playerCount', 'mafiozoCount', 'clueCount'],
  'vote.cast':                         ['targetKind', 'round'],
  'vote.early_close':                  ['reason', 'round', 'eligibleCount', 'votedCount'],
  'feature.ready_to_vote_used':        ['round', 'eligibleCount', 'readyCount'],
  'feature.vote_extension_activated':  ['round', 'eligibleCount', 'requestedCount', 'requiredCount', 'secondsAdded'],
  'ai.call':                           ['task', 'source', 'model', 'ok', 'latencyMs', 'validatorReason'],
  'auth.guest_created':                [],
  'auth.user_registered':              [],
  'auth.user_login':                   [],
  'profile.bio_ai_requested':          ['source', 'ok'],
  'profile.updated':                   ['fieldsChanged'],
  'archive.replay_opened':             ['outcome', 'rounds', 'asAdmin'],
  'error.phase_machine':               ['phase', 'kind', 'note'],
  'event.unknown_type':                ['attemptedType'],
});

const ALLOWED_PRIMITIVE_TYPES = new Set(['string', 'number', 'boolean']);
const ALLOWED_PAYLOAD_VALUE_TYPES = new Set(['string', 'number', 'boolean']);

/**
 * Sanitize a payload: drop dangerous keys (recursively), drop non-allowlisted
 * keys for the given event type, clamp string values, force scalar value
 * types only (string/number/boolean — no nested objects/arrays for events).
 * The resulting object is JSON-serialized once to enforce a hard byte cap.
 */
function sanitizeEventPayload(eventType, payload) {
  const allowed = EVENT_PAYLOAD_ALLOWLIST[eventType] || [];
  const allowedSet = new Set(allowed);

  if (payload === null || payload === undefined) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) return {};

  const out = {};
  for (const k of Object.keys(payload)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    if (!allowedSet.has(k)) continue;
    const v = payload[k];
    if (v === null || v === undefined) continue;
    if (!ALLOWED_PAYLOAD_VALUE_TYPES.has(typeof v)) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    if (typeof v === 'string') {
      out[k] = clampSafeText(v, MAX_METADATA_STR_LEN);
    } else {
      out[k] = v;
    }
  }

  // Hard byte cap.
  let serialized;
  try {
    serialized = JSON.stringify(out);
  } catch {
    return { _truncated: 'payload_unserializable' };
  }
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    return { _truncated: 'payload_too_large', _bytes: serialized.length };
  }
  return out;
}

/**
 * Coerce + clamp every field on an event-log input record. Resilient to
 * null/undefined input. If event_type is unknown, returns a record with
 * event_type = 'event.unknown_type' and payload.attemptedType set so the
 * row is still observable in admin without leaking the bad input shape.
 */
function normalizeEventInput(input) {
  const i = input || {};
  let rawType = clampSafeText(i.eventType, MAX_EVENT_TYPE_LEN);
  let eventType = rawType;
  let payload = i.payload;

  if (!rawType || !KNOWN_EVENT_TYPES.has(rawType)) {
    payload = { attemptedType: rawType || 'unknown' };
    eventType = EVENT_TYPES.EVENT_UNKNOWN_TYPE;
  }

  return {
    eventType,
    userId: Number.isFinite(i.userId) ? Math.trunc(i.userId) : null,
    gameId: i.gameId === null || i.gameId === undefined
      ? null
      : clampSafeText(i.gameId, MAX_GAME_ID_LEN),
    payload: sanitizeEventPayload(eventType, payload),
  };
}

/**
 * Construct an event logger bound to a specific query function. Tests
 * inject a fake query; production uses the lazy default below.
 */
function createEventLogger({ query }) {
  if (typeof query !== 'function') {
    throw new TypeError('createEventLogger requires { query: function }');
  }
  return async function logEvent(args) {
    try {
      const n = normalizeEventInput(args);
      await query(
        `INSERT INTO analytics_events (event_type, user_id, game_id, payload)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [n.eventType, n.userId, n.gameId, JSON.stringify(n.payload)]
      );
    } catch (err) {
      const code = err && err.code ? String(err.code) : null;
      const msg = err && err.message ? String(err.message).slice(0, 120) : 'unknown';
      console.warn('[analytics] event insert failed:', code || msg);
    }
  };
}

let _defaultEventLogger = null;
function getDefaultEventLogger() {
  if (_defaultEventLogger) return _defaultEventLogger;
  // Lazy require: tests that import this module must NOT trigger DB boot.
  const { query } = require('../database');
  _defaultEventLogger = createEventLogger({ query });
  return _defaultEventLogger;
}

/**
 * Default event logger for production code. Fire-and-forget:
 *   logEvent({...}).catch(() => {});
 */
async function logEvent(args) {
  try {
    const fn = getDefaultEventLogger();
    return await fn(args);
  } catch {
    console.warn('[analytics] default event logger setup failed');
  }
}

// Suppress unused-warning for the primitive type set; reserved for future
// nested-payload support. Currently only scalar payload values are accepted.
void ALLOWED_PRIMITIVE_TYPES;

module.exports = {
  // C1
  logAiGeneration,
  createAiLogger,
  sanitizeAiMetadata,
  normalizeAiLogInput,
  clampSafeText,
  // F1
  logEvent,
  createEventLogger,
  normalizeEventInput,
  sanitizeEventPayload,
  EVENT_TYPES,
  EVENT_PAYLOAD_ALLOWLIST,
};
