/**
 * F2 — admin auth middleware tests.
 *
 * Tests the DB-backed admin gate via createAdminRequired() with an injected
 * fake query function. NO express, NO real DB, NO network.
 *
 * What this file pins:
 *   1. isUserAdminRow returns false for missing row.
 *   2. isUserAdminRow returns true ONLY for the exact admin signals
 *      (true | 't' | 'true' | 1) — never for arbitrary truthy values.
 *   3. createAdminRequired requires { query: function }.
 *   4. Middleware calls authRequired first; 401 short-circuits before any
 *      DB call.
 *   5. Authenticated non-admin → 403 with the documented Arabic copy.
 *   6. Authenticated admin → next() called; req.user.isAdmin set to true.
 *   7. DB error during gate lookup → 503 (not 500, not 200) with no leak
 *      of the underlying error.
 *   8. Bootstrap is direct SQL only — verified by static-source grep that
 *      no API path UPDATEs is_admin (anti-escalation contract).
 */
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isUserAdminRow,
  createAdminRequired,
} = require('../middleware/admin');

// ---------------------------------------------------------------------------
// Tiny fakes — req/res/next that capture the shape we care about.
// ---------------------------------------------------------------------------

function makeRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    body: undefined,
  };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.body = obj; res.headersSent = true; return res; };
  return res;
}

// authRequired-stub: simulates a passing auth that populates req.user with
// the supplied id, then calls next(). Used to skip the JWT path under test.
function fakeAuthOk(userId, extra = {}) {
  return function fakeAuth(req, res, next) {
    req.user = { id: userId, username: 'A', isGuest: false, isAdmin: false, ...extra };
    return next();
  };
}

// authRequired-stub: simulates a failed auth that 401s without calling next.
function fakeAuth401() {
  return function fakeAuth(_req, res) {
    res.status(401).json({ error: 'غير مصرح.' });
  };
}

// ---------------------------------------------------------------------------
// 1–2: isUserAdminRow
// ---------------------------------------------------------------------------

test('F2.1 isUserAdminRow returns false for missing or empty row', () => {
  assert.equal(isUserAdminRow(null), false);
  assert.equal(isUserAdminRow(undefined), false);
  assert.equal(isUserAdminRow({}), false);
});

test('F2.2 isUserAdminRow returns true ONLY for exact admin signals', () => {
  assert.equal(isUserAdminRow({ is_admin: true }), true);
  assert.equal(isUserAdminRow({ is_admin: 't' }), true);
  assert.equal(isUserAdminRow({ is_admin: 'true' }), true);
  assert.equal(isUserAdminRow({ is_admin: 1 }), true);
  // NOT admin signals — defensive against silent type drift:
  assert.equal(isUserAdminRow({ is_admin: false }), false);
  assert.equal(isUserAdminRow({ is_admin: 'f' }), false);
  assert.equal(isUserAdminRow({ is_admin: 'false' }), false);
  assert.equal(isUserAdminRow({ is_admin: 0 }), false);
  assert.equal(isUserAdminRow({ is_admin: null }), false);
  assert.equal(isUserAdminRow({ is_admin: undefined }), false);
  assert.equal(isUserAdminRow({ is_admin: 'yes' }), false);
  assert.equal(isUserAdminRow({ is_admin: 'TRUE' }), false);  // case-strict
  assert.equal(isUserAdminRow({ is_admin: 2 }), false);
  assert.equal(isUserAdminRow({ is_admin: '1' }), false);
});

// ---------------------------------------------------------------------------
// 3: factory validation
// ---------------------------------------------------------------------------

test('F2.3 createAdminRequired requires { query: function }', () => {
  assert.throws(() => createAdminRequired({}), /createAdminRequired/);
  assert.throws(() => createAdminRequired({ query: null }), /createAdminRequired/);
  assert.throws(() => createAdminRequired({ query: 'not-a-function' }), /createAdminRequired/);
});

// ---------------------------------------------------------------------------
// 4: 401 short-circuits before DB call
// ---------------------------------------------------------------------------

test('F2.4 401 from authRequired short-circuits — DB query is never called', async () => {
  let queryCalled = false;
  const fakeQuery = async () => { queryCalled = true; return { rows: [] }; };
  const mw = createAdminRequired({ query: fakeQuery, authMw: fakeAuth401() });

  const req = {};
  const res = makeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });

  await new Promise((r) => setImmediate(r));

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(queryCalled, false, 'DB must NOT be queried when auth fails');
});

// ---------------------------------------------------------------------------
// 5: non-admin 403
// ---------------------------------------------------------------------------

test('F2.5 authenticated non-admin → 403 with documented Arabic copy', async () => {
  const fakeQuery = async (_sql, _params) => ({ rows: [{ is_admin: false }] });
  const mw = createAdminRequired({ query: fakeQuery, authMw: fakeAuthOk(123) });

  const req = {};
  const res = makeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });

  await new Promise((r) => setImmediate(r));

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'مش مسموح لك تدخل لوحة التحكم.');
});

// ---------------------------------------------------------------------------
// 6: admin → next() + req.user.isAdmin
// ---------------------------------------------------------------------------

test('F2.6 authenticated admin → next() + req.user.isAdmin = true', async () => {
  const fakeQuery = async (_sql, _params) => ({ rows: [{ is_admin: true }] });
  const mw = createAdminRequired({ query: fakeQuery, authMw: fakeAuthOk(42) });

  const req = {};
  const res = makeRes();
  let nextCalled = false;
  let nextErr = null;
  mw(req, res, (err) => { nextCalled = true; nextErr = err; });

  await new Promise((r) => setImmediate(r));

  assert.equal(nextCalled, true, 'next() must be called for admin');
  assert.equal(nextErr, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(req.user.isAdmin, true);
  assert.equal(req.user.id, 42);
});

// ---------------------------------------------------------------------------
// 7: DB error → 503 with no leak
// ---------------------------------------------------------------------------

test('F2.7 DB error during gate query → 503 with no leak of error', async () => {
  const fakeQuery = async () => {
    throw Object.assign(new Error('connection refused: secret-leak'), { code: 'ECONNREFUSED' });
  };
  const mw = createAdminRequired({ query: fakeQuery, authMw: fakeAuthOk(123) });

  const req = {};
  const res = makeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });

  await new Promise((r) => setImmediate(r));

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  // No leak of the underlying error message.
  assert.ok(!String(res.body.error || '').includes('secret-leak'));
  assert.ok(!String(res.body.error || '').includes('connection refused'));
});

// ---------------------------------------------------------------------------
// 8: anti-escalation — no API path may UPDATE is_admin
// ---------------------------------------------------------------------------

test('F2.8 anti-escalation: no route file UPDATEs users.is_admin', () => {
  const routesDir = path.resolve(__dirname, '..', 'routes');
  const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const text = fs.readFileSync(path.join(routesDir, f), 'utf8');
    // The forbidden patterns. is_admin is set by direct SQL only.
    assert.equal(/SET\s+is_admin/i.test(text), false,
      `route ${f} must NOT contain "SET is_admin" (escalation hole)`);
    assert.equal(/UPDATE\s+users[\s\S]{0,200}is_admin/i.test(text), false,
      `route ${f} must NOT contain UPDATE users ... is_admin`);
    assert.equal(/INSERT\s+INTO\s+users[\s\S]{0,300}is_admin/i.test(text), false,
      `route ${f} must NOT INSERT users with is_admin`);
  }
});

// ---------------------------------------------------------------------------
// 9: /api/auth/me static-source check — issues isAdmin from DB live, not JWT
// ---------------------------------------------------------------------------

test('F2.9 /api/auth/me sources isAdmin from a DB query, NOT from JWT decoded.isAdmin', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'routes', 'auth.js'),
    'utf8'
  );
  // Must SELECT is_admin from users in the /me handler.
  assert.match(text, /SELECT\s+is_admin\s+FROM\s+users\s+WHERE\s+id\s*=\s*\$1/i);
  // Must NOT trust decoded.isAdmin.
  assert.equal(/decoded\.isAdmin/.test(text), false,
    '/me handler must not trust decoded.isAdmin from the JWT');
});
