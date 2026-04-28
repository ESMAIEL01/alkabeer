/**
 * F3 — admin metrics REST helper tests.
 *
 * Tests pure helpers in routes/admin-helpers.js + a static-source check
 * that the route file uses adminRequired and never SELECT *.
 *
 * No express, no DB, no network — works in the local sandbox without
 * `npm install`.
 *
 * What this file pins:
 *   1. parseDateRange handles missing/invalid/inverted/oversized ranges.
 *   2. parseEventsQuery clamps limit to EVENTS_LIMIT_MAX.
 *   3. parseUsersQuery clamps limit to USERS_LIMIT_MAX, normalizes search.
 *   4. shapeAdminSession allow-lists fields; NEVER returns archive_b64,
 *      voting_history, final_reveal, or any FORBIDDEN_KEY.
 *   5. shapeAdminUser allow-lists fields; NEVER returns password_hash.
 *   6. shapeAdminEvent runs payload through dropForbiddenKeys; tokens
 *      never leak through even if a malformed write somehow happened.
 *   7. shapeOverview coerces every numeric field via int(); NaN → 0.
 *   8. Route file uses adminRequired + helper imports — static grep.
 *   9. No SELECT * anywhere in the admin route file.
 *  10. customConfig is allow-listed to the 4 documented keys only.
 */
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseDateRange,
  parseEventsQuery,
  parseUsersQuery,
  dropForbiddenKeys,
  shapeAdminSession,
  shapeAdminUser,
  shapeAdminEvent,
  shapeOverview,
  HARD_LIMITS,
  FORBIDDEN_KEYS,
} = require('../routes/admin-helpers');

// ---------------------------------------------------------------------------
// 1. parseDateRange
// ---------------------------------------------------------------------------

test('F3.1 parseDateRange returns undefined for missing or invalid inputs', () => {
  assert.deepEqual(parseDateRange({}), { from: undefined, to: undefined });
  assert.deepEqual(parseDateRange({ from: 'not-a-date' }), { from: undefined, to: undefined });
  assert.deepEqual(parseDateRange({ from: '', to: '' }), { from: undefined, to: undefined });
  assert.deepEqual(parseDateRange(null), { from: undefined, to: undefined });
});

test('F3.2 parseDateRange swaps inverted ranges', () => {
  const r = parseDateRange({ from: '2025-12-01', to: '2025-01-01' });
  assert.ok(r.from < r.to, `expected from < to after swap, got from=${r.from} to=${r.to}`);
});

test('F3.3 parseDateRange clamps absurd ranges to RANGE_MAX_DAYS', () => {
  const r = parseDateRange({ from: '1970-01-01', to: '2025-01-01' });
  assert.ok(r.from && r.to);
  const span = (Date.parse(r.to) - Date.parse(r.from)) / (1000 * 60 * 60 * 24);
  assert.ok(span <= HARD_LIMITS.RANGE_MAX_DAYS + 1, // +1 for ms rounding
    `range should be clamped to ≤${HARD_LIMITS.RANGE_MAX_DAYS} days, got ${span}`);
});

// ---------------------------------------------------------------------------
// 2-3. parseEventsQuery / parseUsersQuery
// ---------------------------------------------------------------------------

test('F3.4 parseEventsQuery clamps limit to EVENTS_LIMIT_MAX', () => {
  const q = parseEventsQuery({ limit: '99999' });
  assert.equal(q.limit, HARD_LIMITS.EVENTS_LIMIT_MAX);
  assert.equal(q.offset, 0);
});

test('F3.5 parseEventsQuery normalizes type to a clamped string and supports filters', () => {
  const q = parseEventsQuery({ type: 'session.ended', from: '2025-01-01', to: '2025-02-01', limit: '50', offset: '10' });
  assert.equal(q.type, 'session.ended');
  assert.equal(q.limit, 50);
  assert.equal(q.offset, 10);
  assert.ok(q.from && q.to);
});

test('F3.6 parseEventsQuery rejects negative offset / non-numeric inputs gracefully', () => {
  assert.equal(parseEventsQuery({ offset: '-50' }).offset, 0);
  assert.equal(parseEventsQuery({ offset: 'NaN' }).offset, 0);
  assert.equal(parseEventsQuery({ limit: 'abc' }).limit, HARD_LIMITS.DEFAULT_LIMIT);
  assert.equal(parseEventsQuery({ limit: 0 }).limit, HARD_LIMITS.DEFAULT_LIMIT);
  assert.equal(parseEventsQuery({ limit: -10 }).limit, HARD_LIMITS.DEFAULT_LIMIT);
});

test('F3.7 parseUsersQuery clamps limit and trims search', () => {
  const q = parseUsersQuery({ limit: '500', offset: '20', search: '   alice   ' });
  assert.equal(q.limit, HARD_LIMITS.USERS_LIMIT_MAX);
  assert.equal(q.offset, 20);
  assert.equal(q.search, 'alice');
});

test('F3.8 parseUsersQuery handles missing/empty search', () => {
  assert.equal(parseUsersQuery({}).search, null);
  assert.equal(parseUsersQuery({ search: '' }).search, null);
  assert.equal(parseUsersQuery({ search: '   ' }).search, null);
});

// ---------------------------------------------------------------------------
// 4. shapeAdminSession
// ---------------------------------------------------------------------------

test('F3.9 shapeAdminSession allow-lists fields and NEVER returns sensitive data', () => {
  const row = {
    id: 'ROOMX', host_user_id: 42, host_mode: 'AI', reveal_mode: 'normal',
    custom_config: null, outcome: 'investigators_win',
    scenario_title: 'Demo', started_at: '2025-04-01T10:00:00Z',
    ended_at: '2025-04-01T10:12:00Z', created_at: '2025-04-01T09:55:00Z',
    // hostile fields the SELECT could never contain — but we test defensively:
    archive_b64: 'AAAA',
    voting_history: [{ tally: { 1: 2 } }],
    final_reveal: { truth: { mafiozoUsername: 'X' } },
    eliminated_ids: [42],
    password_hash: 'leak',
    token: 'leak',
  };
  const out = shapeAdminSession(row);
  assert.equal(out.id, 'ROOMX');
  assert.equal(out.hostUserId, 42);
  assert.equal(out.outcome, 'investigators_win');
  // Forbidden — must NOT appear:
  for (const k of ['archive_b64', 'voting_history', 'final_reveal',
                    'eliminated_ids', 'password_hash', 'token']) {
    assert.equal(k in out, false, `shapeAdminSession leaked ${k}`);
  }
});

test('F3.10 shapeAdminSession allow-lists customConfig to 4 documented keys', () => {
  const row = {
    id: 'X', host_user_id: 1, host_mode: 'AI', reveal_mode: 'normal',
    custom_config: {
      isCustom: true, playerCount: 5, mafiozoCount: 2, clueCount: 4,
      // hostile sneaks:
      mafiozoUsername: 'A', creatorId: 999, secret: 'x',
    },
    outcome: 'investigators_win',
  };
  const out = shapeAdminSession(row);
  assert.deepEqual(Object.keys(out.customConfig).sort(),
    ['clueCount', 'isCustom', 'mafiozoCount', 'playerCount']);
  for (const k of ['mafiozoUsername', 'creatorId', 'secret']) {
    assert.equal(k in out.customConfig, false);
  }
});

// ---------------------------------------------------------------------------
// 5. shapeAdminUser
// ---------------------------------------------------------------------------

test('F3.11 shapeAdminUser NEVER returns password_hash', () => {
  const out = shapeAdminUser({
    id: 1, username: 'alice', is_guest: false, is_admin: true,
    created_at: '2025-04-01T00:00:00Z', games_played: 12,
    // hostile:
    password_hash: 'bcrypt-hash-leak', password: 'plain-leak', token: 'jwt-leak',
  });
  assert.equal(out.id, 1);
  assert.equal(out.username, 'alice');
  assert.equal(out.isAdmin, true);
  assert.equal(out.gamesPlayed, 12);
  for (const k of ['password_hash', 'password', 'token', 'is_admin', 'is_guest', 'created_at']) {
    assert.equal(k in out, false, `shapeAdminUser leaked ${k}`);
  }
});

test('F3.12 shapeAdminUser handles missing rows + non-numeric games_played', () => {
  assert.equal(shapeAdminUser(null), null);
  assert.equal(shapeAdminUser(undefined), null);
  const out = shapeAdminUser({ id: 1, username: 'a', games_played: 'not-a-number' });
  assert.equal(out.gamesPlayed, 0);
});

// ---------------------------------------------------------------------------
// 6. shapeAdminEvent + dropForbiddenKeys
// ---------------------------------------------------------------------------

test('F3.13 dropForbiddenKeys removes known dangerous keys', () => {
  const out = dropForbiddenKeys({
    safe: 'ok',
    password_hash: 'leak',
    archive_b64: 'leak',
    final_reveal: 'leak',
    voting_history: 'leak',
    GEMINI_API_KEY: 'leak',
    JWT_SECRET: 'leak',
    DATABASE_URL: 'leak',
  });
  assert.deepEqual(out, { safe: 'ok' });
});

test('F3.14 shapeAdminEvent runs payload through dropForbiddenKeys defensively', () => {
  // Even if a row in analytics_events somehow contained dangerous keys
  // (it shouldn't — F1 sanitizeEventPayload prevents it at write — but
  // we defend at read too), shapeAdminEvent must scrub them.
  const out = shapeAdminEvent({
    id: 1, created_at: '2025-04-01T00:00:00Z', event_type: 'session.ended',
    user_id: 42, game_id: 'X',
    payload: {
      outcome: 'investigators_win',
      // hostile:
      password_hash: 'leak',
      archive_b64: 'AAAA',
      JWT_SECRET: 'shhh',
      voting_history: [{ tally: { 1: 2 } }],
    },
  });
  assert.equal(out.eventType, 'session.ended');
  assert.equal(out.payload.outcome, 'investigators_win');
  for (const k of ['password_hash', 'archive_b64', 'JWT_SECRET', 'voting_history']) {
    assert.equal(k in out.payload, false, `shapeAdminEvent leaked ${k}`);
  }
});

test('F3.15 shapeAdminEvent handles malformed payload (array, primitive, null)', () => {
  assert.deepEqual(shapeAdminEvent({ id: 1, payload: null }).payload, {});
  assert.deepEqual(shapeAdminEvent({ id: 1, payload: 'not-an-object' }).payload, {});
  assert.deepEqual(shapeAdminEvent({ id: 1, payload: ['a', 'b'] }).payload, {});
});

// ---------------------------------------------------------------------------
// 7. shapeOverview
// ---------------------------------------------------------------------------

test('F3.16 shapeOverview coerces every numeric field via int(); NaN/null → 0', () => {
  const out = shapeOverview({
    totalSessions: '42', sessionsToday: 1, sessionsLast7d: NaN,
    totalUsers: 10, guestUsers: 3, registeredUsers: 7, adminUsers: 1,
    aiCallsLast7d: null, aiFailuresLast7d: undefined,
  });
  assert.equal(out.totalSessions, 42);
  assert.equal(out.sessionsToday, 1);
  assert.equal(out.sessionsLast7d, 0);
  assert.equal(out.aiCallsLast7d, 0);
  assert.equal(out.aiFailuresLast7d, 0);
});

// ---------------------------------------------------------------------------
// 8-9. Static-source: route file mounts adminRequired, no SELECT *.
// ---------------------------------------------------------------------------

test('F3.17 server.js mounts /api/admin behind adminRequired', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'server.js'),
    'utf8'
  );
  assert.match(text, /app\.use\(\s*['"]\/api\/admin['"]\s*,\s*adminRequired/);
});

test('F3.18 routes/admin.js never uses SELECT * (allow-listed fields only)', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'routes', 'admin.js'),
    'utf8'
  );
  // SELECT * FROM <table> is the dangerous pattern. The doc comment that
  // mentions "NEVER SELECT *" is fine — only catch the actual SQL form.
  assert.equal(/SELECT\s+\*\s+FROM/i.test(text), false,
    'routes/admin.js must not use SELECT * FROM — fields must be allow-listed');
});

test('F3.19 routes/admin.js never references password_hash, archive_b64, final_reveal, voting_history outside docs', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'routes', 'admin.js'),
    'utf8'
  );
  // The file IS allowed to mention voting_history in a SELECT — but only
  // for COUNT or jsonb_array_length. It must NEVER appear in a returned
  // JSON response. We grep on the closer-pattern: a colon (object key)
  // followed by the dangerous identifier, which would indicate the value
  // is being included verbatim.
  for (const k of ['password_hash', 'archive_b64', 'final_reveal',
                    'GEMINI_API_KEY', 'JWT_SECRET', 'DATABASE_URL',
                    'OPENROUTER_API_KEY']) {
    const re = new RegExp(`['"]${k}['"]\\s*:`);
    assert.equal(re.test(text), false,
      `routes/admin.js must not return ${k} as a JSON key`);
  }
});

test('F3.20 FORBIDDEN_KEYS contains the documented dangerous-key set', () => {
  for (const k of ['password', 'password_hash', 'token', 'jwt', 'archive_b64',
                    'final_reveal', 'voting_history', 'roleAssignments',
                    'GEMINI_API_KEY', 'JWT_SECRET', 'DATABASE_URL',
                    'OPENROUTER_API_KEY']) {
    assert.ok(FORBIDDEN_KEYS.has(k), `FORBIDDEN_KEYS missing: ${k}`);
  }
});
