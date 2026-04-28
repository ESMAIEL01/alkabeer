/**
 * Admin metrics REST endpoints (F3).
 *
 * Mounted at /api/admin in server.js with adminRequired middleware so the
 * call stack for every endpoint is:
 *   authRequired → adminRequired (DB-backed) → handler.
 *
 * Endpoints (all GET, all admin-gated):
 *   GET /metrics/overview
 *   GET /metrics/games?from=&to=
 *   GET /metrics/ai?from=&to=
 *   GET /events?type=&from=&to=&limit=&offset=
 *   GET /users?limit=&offset=&search=
 *
 * Privacy contract:
 *   - Every response field is hand-coded via shape* helpers in
 *     ./admin-helpers.js — NEVER SELECT *.
 *   - Forbidden keys (password_hash, archive_b64, raw final_reveal,
 *     raw voting_history, JWTs, secrets) NEVER appear in any payload.
 *   - The events browser's payload column went through F1's
 *     sanitizeEventPayload at WRITE time and goes through
 *     dropForbiddenKeys again at READ time.
 *   - ALL aggregation queries are admin-only because individual rows
 *     are correlations of multiple users; the admin gate is what
 *     authorizes access.
 *
 * Pagination:
 *   - events limit clamped to HARD_LIMITS.EVENTS_LIMIT_MAX (100).
 *   - users limit clamped to HARD_LIMITS.USERS_LIMIT_MAX (100).
 *
 * Date range:
 *   - parseDateRange clamps absurd ranges to RANGE_MAX_DAYS (366).
 *   - Missing both → SQL substitutes default 30-day window.
 */
const express = require('express');
const { query } = require('../database');
const {
  parseDateRange,
  parseEventsQuery,
  parseUsersQuery,
  shapeAdminSession,
  shapeAdminUser,
  shapeAdminEvent,
  shapeOverview,
} = require('./admin-helpers');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers — keep the SQL local. Date-range default is "last 30 days".
// ---------------------------------------------------------------------------

function defaultRangeIfMissing(range) {
  if (range.from && range.to) return range;
  const now = new Date();
  const to = range.to || now.toISOString();
  const from = range.from
    || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

// ---------------------------------------------------------------------------
// GET /metrics/overview
// ---------------------------------------------------------------------------

router.get('/metrics/overview', async (_req, res, next) => {
  try {
    const [
      { rows: sessTotal },
      { rows: sessToday },
      { rows: sess7d },
      { rows: usersTotal },
      { rows: usersGuest },
      { rows: usersAdmin },
      { rows: aiTotal7d },
      { rows: aiFails7d },
    ] = await Promise.all([
      query('SELECT COUNT(*)::bigint AS n FROM game_sessions'),
      query('SELECT COUNT(*)::bigint AS n FROM game_sessions WHERE created_at >= NOW() - INTERVAL \'1 day\''),
      query('SELECT COUNT(*)::bigint AS n FROM game_sessions WHERE created_at >= NOW() - INTERVAL \'7 days\''),
      query('SELECT COUNT(*)::bigint AS n FROM users'),
      query('SELECT COUNT(*)::bigint AS n FROM users WHERE is_guest = TRUE'),
      query('SELECT COUNT(*)::bigint AS n FROM users WHERE is_admin = TRUE'),
      query('SELECT COUNT(*)::bigint AS n FROM ai_generation_logs WHERE created_at >= NOW() - INTERVAL \'7 days\''),
      query('SELECT COUNT(*)::bigint AS n FROM ai_generation_logs WHERE created_at >= NOW() - INTERVAL \'7 days\' AND ok = FALSE'),
    ]);

    const totalUsers = num(usersTotal[0]);
    const guestUsers = num(usersGuest[0]);
    return res.json(shapeOverview({
      totalSessions: num(sessTotal[0]),
      sessionsToday: num(sessToday[0]),
      sessionsLast7d: num(sess7d[0]),
      totalUsers,
      guestUsers,
      registeredUsers: Math.max(0, totalUsers - guestUsers),
      adminUsers: num(usersAdmin[0]),
      aiCallsLast7d: num(aiTotal7d[0]),
      aiFailuresLast7d: num(aiFails7d[0]),
    }));
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /metrics/games
// Aggregates by mode, reveal mode, outcome, custom usage, average rounds,
// and average duration over a [from, to] window.
// ---------------------------------------------------------------------------

router.get('/metrics/games', async (req, res, next) => {
  const { from, to } = defaultRangeIfMissing(parseDateRange(req.query || {}));
  try {
    const params = [from, to];
    const [
      { rows: byMode },
      { rows: byReveal },
      { rows: byOutcome },
      { rows: customUsage },
      { rows: avgRow },
    ] = await Promise.all([
      query(
        `SELECT host_mode AS k, COUNT(*)::bigint AS n
           FROM game_sessions
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY host_mode`,
        params
      ),
      query(
        `SELECT reveal_mode AS k, COUNT(*)::bigint AS n
           FROM game_sessions
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY reveal_mode`,
        params
      ),
      query(
        `SELECT COALESCE(outcome, 'unknown') AS k, COUNT(*)::bigint AS n
           FROM game_sessions
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY COALESCE(outcome, 'unknown')`,
        params
      ),
      query(
        `SELECT
           COUNT(*) FILTER (WHERE custom_config IS NOT NULL)::bigint AS custom_n,
           COUNT(*)::bigint AS total_n
           FROM game_sessions
          WHERE created_at >= $1 AND created_at < $2`,
        params
      ),
      query(
        `SELECT
           AVG(jsonb_array_length(voting_history))::float    AS avg_rounds,
           AVG(EXTRACT(EPOCH FROM (ended_at - started_at)))::float AS avg_duration_sec
           FROM game_sessions
          WHERE created_at >= $1 AND created_at < $2
            AND ended_at IS NOT NULL AND started_at IS NOT NULL`,
        params
      ),
    ]);

    return res.json({
      from, to,
      byMode: rowsToMap(byMode),
      byRevealMode: rowsToMap(byReveal),
      byOutcome: rowsToMap(byOutcome),
      customUsage: {
        custom: num(customUsage[0] && customUsage[0].custom_n),
        total: num(customUsage[0] && customUsage[0].total_n),
      },
      avgRounds: avgRow[0] && Number.isFinite(avgRow[0].avg_rounds) ? avgRow[0].avg_rounds : null,
      avgDurationSec: avgRow[0] && Number.isFinite(avgRow[0].avg_duration_sec) ? avgRow[0].avg_duration_sec : null,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /metrics/ai
// AI provider attempts grouped by task + source, with latency stats.
// ---------------------------------------------------------------------------

router.get('/metrics/ai', async (req, res, next) => {
  const { from, to } = defaultRangeIfMissing(parseDateRange(req.query || {}));
  try {
    const params = [from, to];
    const [
      { rows: byTaskSource },
      { rows: latencyRow },
      { rows: errorCount },
    ] = await Promise.all([
      query(
        `SELECT task, source,
                COUNT(*)::bigint               AS attempts,
                COUNT(*) FILTER (WHERE ok)::bigint AS successes,
                AVG(latency_ms)::float         AS avg_latency_ms
           FROM ai_generation_logs
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY task, source
          ORDER BY task, source`,
        params
      ),
      query(
        `SELECT
           AVG(latency_ms)::float                          AS overall_avg_latency_ms,
           MAX(latency_ms)::float                          AS overall_max_latency_ms
         FROM ai_generation_logs
         WHERE created_at >= $1 AND created_at < $2 AND latency_ms IS NOT NULL`,
        params
      ),
      query(
        `SELECT validator_reason AS k, COUNT(*)::bigint AS n
           FROM ai_generation_logs
          WHERE created_at >= $1 AND created_at < $2 AND ok = FALSE
          GROUP BY validator_reason
          ORDER BY n DESC
          LIMIT 20`,
        params
      ),
    ]);

    return res.json({
      from, to,
      byTaskSource: byTaskSource.map(r => ({
        task: r.task || null,
        source: r.source || null,
        attempts: num(r.attempts),
        successes: num(r.successes),
        avgLatencyMs: Number.isFinite(r.avg_latency_ms) ? r.avg_latency_ms : null,
      })),
      overallAvgLatencyMs: latencyRow[0] && Number.isFinite(latencyRow[0].overall_avg_latency_ms) ? latencyRow[0].overall_avg_latency_ms : null,
      overallMaxLatencyMs: latencyRow[0] && Number.isFinite(latencyRow[0].overall_max_latency_ms) ? latencyRow[0].overall_max_latency_ms : null,
      topFailureReasons: errorCount.map(r => ({
        reason: r.k || 'unknown',
        count: num(r.n),
      })),
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /events
// Paginated raw event browser. Allow-listed shaping per row.
// ---------------------------------------------------------------------------

router.get('/events', async (req, res, next) => {
  const q = parseEventsQuery(req.query || {});
  try {
    // Build a parameterized SQL with optional filters.
    const where = [];
    const params = [];
    if (q.type) { params.push(q.type); where.push(`event_type = $${params.length}`); }
    if (q.from) { params.push(q.from); where.push(`created_at >= $${params.length}`); }
    if (q.to)   { params.push(q.to);   where.push(`created_at < $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // limit + offset go LAST so their $-numbers are stable.
    params.push(q.limit);
    const limitParam = params.length;
    params.push(q.offset);
    const offsetParam = params.length;

    const [{ rows: eventRows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT id, created_at, event_type, user_id, game_id, payload
           FROM analytics_events
           ${whereSql}
          ORDER BY id DESC
          LIMIT $${limitParam} OFFSET $${offsetParam}`,
        params
      ),
      query(
        `SELECT COUNT(*)::bigint AS n
           FROM analytics_events
           ${whereSql}`,
        params.slice(0, where.length)
      ),
    ]);

    return res.json({
      events: eventRows.map(shapeAdminEvent).filter(Boolean),
      total: num(countRows[0] && countRows[0].n),
      limit: q.limit,
      offset: q.offset,
      type: q.type,
      from: q.from || null,
      to: q.to || null,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /users
// User list with games_played count. Search is ILIKE on username.
// ---------------------------------------------------------------------------

router.get('/users', async (req, res, next) => {
  const q = parseUsersQuery(req.query || {});
  try {
    const where = [];
    const params = [];
    if (q.search) {
      params.push(`%${q.search}%`);
      where.push(`u.username ILIKE $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    params.push(q.limit);
    const limitParam = params.length;
    params.push(q.offset);
    const offsetParam = params.length;

    const [{ rows: userRows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT u.id, u.username, u.is_guest, u.is_admin, u.created_at,
                COALESCE(COUNT(p.user_id), 0)::int AS games_played
           FROM users u
           LEFT JOIN game_participants p ON p.user_id = u.id
           ${whereSql}
          GROUP BY u.id
          ORDER BY u.id DESC
          LIMIT $${limitParam} OFFSET $${offsetParam}`,
        params
      ),
      query(
        `SELECT COUNT(*)::bigint AS n FROM users u
         ${whereSql}`,
        params.slice(0, where.length)
      ),
    ]);

    return res.json({
      users: userRows.map(shapeAdminUser).filter(Boolean),
      total: num(countRows[0] && countRows[0].n),
      limit: q.limit,
      offset: q.offset,
      search: q.search,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Tiny utilities
// ---------------------------------------------------------------------------

function num(row) {
  if (!row) return 0;
  const v = (row.n !== undefined) ? row.n : row;
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function rowsToMap(rows) {
  const out = {};
  for (const r of rows || []) {
    if (!r || !r.k) continue;
    out[r.k] = num(r);
  }
  return out;
}

module.exports = router;
// Re-exports for parity with profile.js / archive.js patterns.
module.exports.parseDateRange = parseDateRange;
module.exports.parseEventsQuery = parseEventsQuery;
module.exports.parseUsersQuery = parseUsersQuery;
module.exports.shapeAdminSession = shapeAdminSession;
module.exports.shapeAdminUser = shapeAdminUser;
module.exports.shapeAdminEvent = shapeAdminEvent;
module.exports.shapeOverview = shapeOverview;
