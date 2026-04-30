/**
 * Admin route helpers (F3). Pure functions only — input parsing,
 * validation, response shaping. Tests import this without express,
 * jsonwebtoken, dotenv, or pg.
 *
 * Hard rules pinned by tests:
 *   - parseDateRange clamps absurd ranges and rejects invalid shapes.
 *   - parseEventsQuery clamps limit to a hard maximum.
 *   - shapeAdminSession allow-lists fields — NEVER returns archive_b64,
 *     password_hash, JWT, raw final_reveal, raw voting_history,
 *     roleAssignments, or any secret.
 *   - shapeAdminUser allow-lists fields — NEVER returns password_hash.
 *   - shapeAdminEvent allow-lists fields — payload comes through the
 *     analytics-side allow-list, but here we add a defensive second check
 *     that no obviously-dangerous keys appear.
 */

const HARD_LIMITS = Object.freeze({
  EVENTS_LIMIT_MAX: 100,
  USERS_LIMIT_MAX: 100,
  DEFAULT_LIMIT: 25,
  // Date range clamp: don't let an admin "from=1970" walk the whole table.
  // The dashboard surface is for recent-windowed aggregates; ad-hoc deep
  // history queries should use direct DB access.
  RANGE_MAX_DAYS: 366,
});

// Always-visible columns for sessions (admin metrics surface). Never
// archive_b64, never raw final_reveal, never voting_history.
const ADMIN_SESSION_FIELDS = Object.freeze([
  'id', 'host_user_id', 'host_mode', 'reveal_mode', 'custom_config',
  'outcome', 'scenario_title', 'started_at', 'ended_at', 'created_at',
]);

// Forbidden keys — second-line defense for admin payload shaping. Any
// row coming back from a hand-written SELECT that accidentally includes
// these gets dropped at shape time.
const FORBIDDEN_KEYS = new Set([
  'password', 'password_hash', 'token', 'jwt', 'authorization',
  'archive_b64', 'final_reveal', 'voting_history', 'eliminated_ids',
  'roleAssignments', 'votes', 'rawPrompt', 'prompt', 'response',
  'rawResponse', 'output', 'text', 'apiKey', 'api_key', 'secret',
  'DATABASE_URL', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'JWT_SECRET',
]);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Parse and validate ?from= / ?to= ISO-8601 timestamp strings. Returns
 * { from, to } as ISO strings (or undefined if absent). Always clamps the
 * range to RANGE_MAX_DAYS.
 *
 * Fallback rules:
 *   - missing both → returns { from: undefined, to: undefined }
 *     and the SQL caller substitutes the default 30-day window.
 *   - missing only one → the present one is honored; the missing one
 *     uses the open boundary in SQL.
 *   - invalid date string → silently dropped (treated as missing).
 *   - inverted range (from > to) → swapped.
 */
function parseDateRange(query) {
  const q = query || {};
  let from = parseIsoDate(q.from);
  let to = parseIsoDate(q.to);
  if (from && to && from > to) {
    const tmp = from; from = to; to = tmp;
  }
  if (from && to) {
    const days = Math.abs(to - from) / (1000 * 60 * 60 * 24);
    if (days > HARD_LIMITS.RANGE_MAX_DAYS) {
      // Clamp by moving the from boundary forward.
      from = new Date(to.getTime() - HARD_LIMITS.RANGE_MAX_DAYS * 24 * 60 * 60 * 1000);
    }
  }
  return {
    from: from ? from.toISOString() : undefined,
    to:   to   ? to.toISOString()   : undefined,
  };
}

function parseIsoDate(input) {
  if (typeof input !== 'string' || !input) return null;
  const t = Date.parse(input);
  if (!Number.isFinite(t)) return null;
  return new Date(t);
}

/**
 * Parse pagination + filters for /api/admin/events. Limit hard-capped to
 * EVENTS_LIMIT_MAX. Offset minimum 0.
 */
function parseEventsQuery(query) {
  const q = query || {};
  let limit = Number.parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = HARD_LIMITS.DEFAULT_LIMIT;
  if (limit > HARD_LIMITS.EVENTS_LIMIT_MAX) limit = HARD_LIMITS.EVENTS_LIMIT_MAX;

  let offset = Number.parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  let type = null;
  if (typeof q.type === 'string' && q.type.trim()) {
    // Hard ceiling on length; the analytics taxonomy is short (under 64).
    type = q.type.trim().slice(0, 64);
  }

  const range = parseDateRange(q);
  return { limit, offset, type, from: range.from, to: range.to };
}

/**
 * Parse pagination + status filter + search for /api/admin/accounts.
 */
const VALID_ACCOUNT_STATUSES = new Set(['all', 'pending', 'approved', 'rejected', 'deleted']);

function parseAccountsQuery(query) {
  const q = query || {};
  let limit = Number.parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = HARD_LIMITS.DEFAULT_LIMIT;
  if (limit > HARD_LIMITS.USERS_LIMIT_MAX) limit = HARD_LIMITS.USERS_LIMIT_MAX;

  let offset = Number.parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  let search = null;
  if (typeof q.search === 'string') {
    const s = q.search.trim();
    if (s) search = s.slice(0, 64);
  }

  const status = (typeof q.status === 'string' && VALID_ACCOUNT_STATUSES.has(q.status))
    ? q.status
    : 'all';

  return { limit, offset, search, status };
}

/**
 * Parse pagination + search for /api/admin/users.
 */
function parseUsersQuery(query) {
  const q = query || {};
  let limit = Number.parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = HARD_LIMITS.DEFAULT_LIMIT;
  if (limit > HARD_LIMITS.USERS_LIMIT_MAX) limit = HARD_LIMITS.USERS_LIMIT_MAX;

  let offset = Number.parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  let search = null;
  if (typeof q.search === 'string') {
    const s = q.search.trim();
    if (s) search = s.slice(0, 64);
  }

  return { limit, offset, search };
}

/**
 * Drop forbidden keys from a flat object. Used as a defensive second-line
 * filter in shape* functions. Tests assert no forbidden key reaches the
 * response.
 */
function dropForbiddenKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = obj[k];
  }
  return out;
}

/**
 * Shape one game_sessions row for the admin metrics surface.
 * Hand-coded allow-list. Returns null for empty input.
 */
function shapeAdminSession(row) {
  if (!row || typeof row !== 'object') return null;
  // The only JSONB column we surface here is custom_config. We pass it
  // through as-is because routes/scenarios.js#normalizeCustomCounters
  // and GameManager.normalizeGameConfig already produced a 4-key
  // allow-listed shape; on the read path, we re-clamp defensively.
  let customConfig = null;
  if (row.custom_config && typeof row.custom_config === 'object') {
    customConfig = {
      isCustom:     !!row.custom_config.isCustom,
      playerCount:  Number.isFinite(row.custom_config.playerCount)  ? row.custom_config.playerCount  : null,
      mafiozoCount: Number.isFinite(row.custom_config.mafiozoCount) ? row.custom_config.mafiozoCount : null,
      clueCount:    Number.isFinite(row.custom_config.clueCount)    ? row.custom_config.clueCount    : null,
    };
  }
  return {
    id: row.id,
    hostUserId: Number.isFinite(row.host_user_id) ? row.host_user_id : null,
    hostMode: row.host_mode || null,
    revealMode: row.reveal_mode || null,
    customConfig,
    outcome: row.outcome || null,
    scenarioTitle: typeof row.scenario_title === 'string' ? row.scenario_title : null,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

/**
 * Shape one users row + games_played count. NEVER returns password_hash.
 */
function shapeAdminUser(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    username: row.username || null,
    isGuest: !!row.is_guest,
    isAdmin: !!row.is_admin,
    status: row.status || 'approved',
    gamesPlayed: Number.isFinite(row.games_played) ? row.games_played : 0,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

/**
 * Shape one users row for the accounts management surface.
 * Includes lifecycle timestamps. NEVER returns password_hash.
 */
function shapeAdminAccount(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    username: row.username || null,
    isGuest: !!row.is_guest,
    isAdmin: !!row.is_admin,
    status: row.status || 'approved',
    gamesPlayed: Number.isFinite(row.games_played) ? row.games_played : 0,
    createdAt:  row.created_at  ? new Date(row.created_at).toISOString()  : null,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    rejectedAt: row.rejected_at ? new Date(row.rejected_at).toISOString() : null,
    deletedAt:  row.deleted_at  ? new Date(row.deleted_at).toISOString()  : null,
    expiresAt:  row.expires_at  ? new Date(row.expires_at).toISOString()  : null,
  };
}

/**
 * Shape one analytics_events row for the admin events browser. Payload
 * is taken from the JSONB column unchanged — it was already allow-listed
 * at WRITE time by services/analytics.js#sanitizeEventPayload (F1). As
 * defense in depth, we run dropForbiddenKeys over it again on read.
 */
function shapeAdminEvent(row) {
  if (!row || typeof row !== 'object') return null;
  let payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
    ? dropForbiddenKeys(row.payload)
    : {};
  return {
    id: Number.isFinite(row.id) ? row.id : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    eventType: row.event_type || null,
    userId: Number.isFinite(row.user_id) ? row.user_id : null,
    gameId: row.game_id || null,
    payload,
  };
}

/**
 * Shape an aggregate metrics result. Defensive — never echoes raw rows.
 */
function shapeOverview(input) {
  const i = input || {};
  return {
    totalSessions: int(i.totalSessions),
    sessionsToday: int(i.sessionsToday),
    sessionsLast7d: int(i.sessionsLast7d),
    totalUsers: int(i.totalUsers),
    guestUsers: int(i.guestUsers),
    registeredUsers: int(i.registeredUsers),
    adminUsers: int(i.adminUsers),
    pendingAccounts: int(i.pendingAccounts),
    aiCallsLast7d: int(i.aiCallsLast7d),
    aiFailuresLast7d: int(i.aiFailuresLast7d),
  };
}

function int(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

module.exports = {
  parseDateRange,
  parseEventsQuery,
  parseUsersQuery,
  parseAccountsQuery,
  dropForbiddenKeys,
  shapeAdminSession,
  shapeAdminUser,
  shapeAdminAccount,
  shapeAdminEvent,
  shapeOverview,
  HARD_LIMITS,
  ADMIN_SESSION_FIELDS,
  FORBIDDEN_KEYS,
};
