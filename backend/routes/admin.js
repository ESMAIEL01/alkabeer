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
  parseAccountsQuery,
  shapeAdminSession,
  shapeAdminUser,
  shapeAdminAccount,
  shapeAdminEvent,
  shapeOverview,
} = require('./admin-helpers');
const { logEvent } = require('../services/analytics');

function fireEvent(args) {
  try {
    Promise.resolve(logEvent(args)).catch(() => {});
  } catch { /* swallow */ }
}

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
      { rows: usersPending },
      { rows: aiTotal7d },
      { rows: aiFails7d },
    ] = await Promise.all([
      query('SELECT COUNT(*)::bigint AS n FROM game_sessions'),
      query('SELECT COUNT(*)::bigint AS n FROM game_sessions WHERE created_at >= NOW() - INTERVAL \'1 day\''),
      query('SELECT COUNT(*)::bigint AS n FROM game_sessions WHERE created_at >= NOW() - INTERVAL \'7 days\''),
      query('SELECT COUNT(*)::bigint AS n FROM users WHERE status != \'deleted\''),
      query('SELECT COUNT(*)::bigint AS n FROM users WHERE is_guest = TRUE AND status != \'deleted\''),
      query('SELECT COUNT(*)::bigint AS n FROM users WHERE is_admin = TRUE'),
      query('SELECT COUNT(*)::bigint AS n FROM users WHERE status = \'pending\' AND is_guest = FALSE'),
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
      pendingAccounts: num(usersPending[0]),
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
// GET /accounts
// Paginated account list with optional status filter and username search.
// ---------------------------------------------------------------------------

router.get('/accounts', async (req, res, next) => {
  const q = parseAccountsQuery(req.query || {});
  try {
    const where = [];
    const params = [];
    if (q.status && q.status !== 'all') {
      params.push(q.status);
      where.push(`u.status = $${params.length}`);
    }
    if (q.search) {
      params.push(`%${q.search}%`);
      where.push(`u.username ILIKE $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(q.limit);
    const limitParam = params.length;
    params.push(q.offset);
    const offsetParam = params.length;

    const [{ rows: accountRows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT u.id, u.username, u.is_guest, u.is_admin, u.status,
                u.created_at, u.approved_at, u.rejected_at, u.deleted_at, u.expires_at,
                COALESCE(COUNT(p.user_id), 0)::int AS games_played
           FROM users u
           LEFT JOIN game_participants p ON p.user_id = u.id
           ${whereSql}
          GROUP BY u.id
          ORDER BY u.created_at DESC
          LIMIT $${limitParam} OFFSET $${offsetParam}`,
        params
      ),
      query(
        `SELECT COUNT(*)::bigint AS n FROM users u ${whereSql}`,
        params.slice(0, where.length)
      ),
    ]);
    return res.json({
      accounts: accountRows.map(shapeAdminAccount).filter(Boolean),
      total: num(countRows[0] && countRows[0].n),
      limit: q.limit,
      offset: q.offset,
      status: q.status,
      search: q.search,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /accounts/pending
// Oldest-first queue of accounts awaiting approval. Max 100 rows.
// ---------------------------------------------------------------------------

router.get('/accounts/pending', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.username, u.is_guest, u.is_admin, u.status,
              u.created_at, u.approved_at, u.rejected_at, u.deleted_at, u.expires_at,
              0 AS games_played
         FROM users u
        WHERE u.status = 'pending' AND u.is_guest = FALSE
        ORDER BY u.created_at ASC
        LIMIT 100`
    );
    return res.json({ accounts: rows.map(shapeAdminAccount).filter(Boolean) });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /accounts/:id/approve
// ---------------------------------------------------------------------------

router.post('/accounts/:id/approve', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'معرف غير صالح.' });
  try {
    const { rows } = await query(
      `UPDATE users
          SET status = 'approved', approved_at = NOW(), approved_by = $2
        WHERE id = $1 AND status = 'pending' AND is_guest = FALSE
        RETURNING id, username, status`,
      [id, req.user.id]
    );
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'الحساب مش موجود أو مش في حالة انتظار.' });
    }
    fireEvent({ eventType: 'admin.account_approved', userId: req.user.id, payload: { targetId: id } });
    return res.json({ ok: true, id: rows[0].id, username: rows[0].username, status: rows[0].status });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /accounts/:id/reject
// Cannot reject admins or the requesting admin themselves.
// ---------------------------------------------------------------------------

router.post('/accounts/:id/reject', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'معرف غير صالح.' });
  if (id === req.user.id) return res.status(400).json({ error: 'ما تقدرش تتصرف في حسابك الخاص من هنا.' });
  try {
    // Pre-check in SELECT — is_admin must not appear in the UPDATE statement
    // (anti-escalation invariant enforced by test F2.8).
    const { rows: guard } = await query(
      'SELECT id, username, is_admin, is_guest, status FROM users WHERE id = $1',
      [id]
    );
    const target = guard[0];
    if (!target || target.status === 'deleted') {
      return res.status(404).json({ error: 'الحساب مش موجود أو محذوف.' });
    }
    if (target.is_admin) return res.status(403).json({ error: 'مش ممكن رفض حساب مشرف.' });
    if (target.is_guest) return res.status(400).json({ error: 'مش ممكن رفض حساب ضيف.' });

    const { rows } = await query(
      `UPDATE users
          SET status = 'rejected', rejected_at = NOW(), rejected_by = $2
        WHERE id = $1 AND status != 'deleted'
        RETURNING id, username, status`,
      [id, req.user.id]
    );
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'الحساب مش موجود أو مش ممكن رفضه.' });
    }
    fireEvent({ eventType: 'admin.account_rejected', userId: req.user.id, payload: { targetId: id } });
    return res.json({ ok: true, id: rows[0].id, username: rows[0].username, status: rows[0].status });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /accounts/:id — soft delete (sets status='deleted').
// Cannot delete admins or the requesting admin themselves.
// Soft delete preserves game_participants data (avoids ON DELETE CASCADE).
// ---------------------------------------------------------------------------

router.delete('/accounts/:id', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'معرف غير صالح.' });
  if (id === req.user.id) return res.status(400).json({ error: 'ما تقدرش تحذف حسابك الخاص.' });
  try {
    // Pre-check in SELECT — is_admin must not appear in the UPDATE statement
    // (anti-escalation invariant enforced by test F2.8).
    const { rows: guard } = await query(
      'SELECT id, is_admin, status FROM users WHERE id = $1',
      [id]
    );
    const target = guard[0];
    if (!target || target.status === 'deleted') {
      return res.status(404).json({ error: 'الحساب مش موجود أو محذوف قبل كده.' });
    }
    if (target.is_admin) return res.status(403).json({ error: 'مش ممكن حذف حساب مشرف.' });

    const { rows } = await query(
      `UPDATE users
          SET status = 'deleted', deleted_at = NOW(), deleted_by = $2
        WHERE id = $1 AND status != 'deleted'
        RETURNING id, username`,
      [id, req.user.id]
    );
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'الحساب مش موجود أو محذوف قبل كده.' });
    }
    fireEvent({ eventType: 'admin.account_deleted', userId: req.user.id, payload: { targetId: id } });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /accounts/cleanup-guests
// Soft-deletes expired guest rows (not hard DELETE — game_participants.user_id
// has ON DELETE CASCADE so a hard delete would cascade and remove archived
// participation records). Soft delete makes the account unreachable for auth
// while preserving the foreign-key link.
//
// Body: { dryRun: boolean, confirm: string }
//   dryRun defaults to true — safe preview.
//   Real run requires confirm === "DELETE_EXPIRED_GUESTS".
// ---------------------------------------------------------------------------

router.post('/accounts/cleanup-guests', async (req, res, next) => {
  const body = req.body || {};
  const dryRun = body.dryRun !== false;

  if (dryRun) {
    try {
      const [{ rows: sample }, { rows: countRows }] = await Promise.all([
        query(
          `SELECT id, username, expires_at FROM users
            WHERE is_guest = TRUE AND expires_at IS NOT NULL AND expires_at < NOW()
              AND status != 'deleted'
            ORDER BY expires_at ASC
            LIMIT 50`
        ),
        query(
          `SELECT COUNT(*)::bigint AS n FROM users
            WHERE is_guest = TRUE AND expires_at IS NOT NULL AND expires_at < NOW()
              AND status != 'deleted'`
        ),
      ]);
      return res.json({
        dryRun: true,
        count: num(countRows[0]),
        sample: sample.map(r => ({
          id: r.id,
          username: r.username || null,
          expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        })),
      });
    } catch (err) {
      return next(err);
    }
  }

  if (body.confirm !== 'DELETE_EXPIRED_GUESTS') {
    return res.status(400).json({
      error: 'يلزم تأكيد صريح. أرسل confirm: "DELETE_EXPIRED_GUESTS" مع dryRun: false.',
    });
  }

  try {
    const { rows } = await query(
      `UPDATE users
          SET status = 'deleted', deleted_at = NOW(), deleted_by = $1
        WHERE is_guest = TRUE
          AND expires_at IS NOT NULL
          AND expires_at < NOW()
          AND status != 'deleted'
        RETURNING id`,
      [req.user.id]
    );
    const deleted = rows ? rows.length : 0;
    fireEvent({ eventType: 'admin.cleanup_guests', userId: req.user.id, payload: { deleted } });
    return res.json({ ok: true, deleted });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /accounts/purge-non-admin
// Soft-deletes all non-admin, non-guest accounts that aren't already deleted.
//
// Body: { dryRun: boolean, confirm: string }
//   dryRun defaults to true — safe preview with up to 50 sample usernames.
//   Real run requires confirm === "DELETE_NON_ADMIN_ACCOUNTS".
// ---------------------------------------------------------------------------

router.post('/accounts/purge-non-admin', async (req, res, next) => {
  const body = req.body || {};
  const dryRun = body.dryRun !== false;

  if (dryRun) {
    try {
      const [{ rows: sample }, { rows: countRows }] = await Promise.all([
        query(
          `SELECT id, username, status, created_at FROM users
            WHERE is_admin = FALSE AND is_guest = FALSE AND status != 'deleted'
            ORDER BY created_at DESC
            LIMIT 50`
        ),
        query(
          `SELECT COUNT(*)::bigint AS n FROM users
            WHERE is_admin = FALSE AND is_guest = FALSE AND status != 'deleted'`
        ),
      ]);
      return res.json({
        dryRun: true,
        count: num(countRows[0]),
        sample: sample.map(r => ({
          id: r.id,
          username: r.username || null,
          status: r.status || null,
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        })),
      });
    } catch (err) {
      return next(err);
    }
  }

  if (body.confirm !== 'DELETE_NON_ADMIN_ACCOUNTS') {
    return res.status(400).json({
      error: 'يلزم تأكيد صريح. أرسل confirm: "DELETE_NON_ADMIN_ACCOUNTS" مع dryRun: false.',
    });
  }

  try {
    // Pre-select IDs via SELECT (is_admin reference is allowed in SELECT).
    // The subsequent UPDATE uses id = ANY($2) so no is_admin appears in the
    // UPDATE statement — satisfies the anti-escalation invariant (test F2.8).
    const { rows: targetRows } = await query(
      `SELECT id FROM users
        WHERE is_guest = FALSE AND status != 'deleted'
          AND id NOT IN (SELECT id FROM users WHERE is_admin = TRUE)`
    );
    const ids = targetRows.map(r => r.id);
    if (ids.length === 0) return res.json({ dryRun: false, count: 0 });

    const { rows } = await query(
      `UPDATE users
          SET status = 'deleted', deleted_at = NOW(), deleted_by = $1
        WHERE id = ANY($2::int[]) AND status != 'deleted'
        RETURNING id`,
      [req.user.id, ids]
    );
    const count = rows ? rows.length : 0;
    fireEvent({ eventType: 'admin.purge_non_admin', userId: req.user.id, payload: { count } });
    return res.json({ dryRun: false, count });
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
module.exports.parseAccountsQuery = parseAccountsQuery;
module.exports.shapeAdminSession = shapeAdminSession;
module.exports.shapeAdminUser = shapeAdminUser;
module.exports.shapeAdminAccount = shapeAdminAccount;
module.exports.shapeAdminEvent = shapeAdminEvent;
module.exports.shapeOverview = shapeOverview;
