/**
 * adminRequired — DB-backed admin gate for protected REST routes (F2).
 *
 * Composition order:
 *   authRequired → adminRequired → handler
 *
 * Why query the DB live instead of trusting JWT.isAdmin
 * ------------------------------------------------------
 * JWTs we issue today are signed with a 7-day expiry (or 24h for guests).
 * If we encoded `isAdmin` into the token at sign time, demoting an admin
 * would not take effect until the user re-logged in — which is a security
 * hole (we want demotion to be instant). The cheap mitigation is to do
 * one tiny SELECT per admin call. The admin surface is low-volume by
 * design (a handful of dashboard requests per minute at peak) so the
 * extra round-trip is negligible. Non-admin users cannot reach this path
 * at all because authRequired already gated them.
 *
 * Output:
 *   200/next: req.user.isAdmin = true; handler runs.
 *   401: authRequired's existing path.
 *   403: caller is authenticated but row.is_admin is not true. Arabic
 *        copy: "مش مسموح لك تدخل لوحة التحكم."
 *
 * Pure-helper export:
 *   isUserAdminRow(row) — returns the boolean. Exported for tests so they
 *   don't need a DB to verify the resolution rule.
 */
// authRequired is lazy-loaded so tests that exercise only the pure
// admin-gate path don't need jsonwebtoken installed locally. Production
// always loads it via the default export below.
let _authRequired = null;
function getAuthRequired() {
  if (_authRequired) return _authRequired;
  _authRequired = require('./auth').authRequired;
  return _authRequired;
}

/**
 * Resolve a user row's admin flag. Returns FALSE for missing rows or any
 * non-boolean column value. Defensive against silent type drift in the
 * is_admin column.
 */
function isUserAdminRow(row) {
  if (!row) return false;
  // Postgres bool comes back as JS true/false; tolerate string/number
  // values for resilience but ONLY accept the exact admin signals.
  if (row.is_admin === true) return true;
  if (row.is_admin === 't' || row.is_admin === 'true') return true;
  if (row.is_admin === 1) return true;
  return false;
}

/**
 * Build an adminRequired middleware bound to a query function. Tests inject
 * a fake query; production binds the real db.query lazy via the default
 * export.
 *
 * @param {Object} deps
 * @param {Function} deps.query   — async (sql, params) => { rows: [] }
 * @param {Function} [deps.authMw] — optional override for authRequired (tests)
 * @returns {Function} express middleware
 */
function createAdminRequired({ query, authMw } = {}) {
  if (typeof query !== 'function') {
    throw new TypeError('createAdminRequired requires { query: function }');
  }
  // Resolve authRequired lazily ONLY if the caller did not supply one. This
  // keeps the pure-helper test path free of the jsonwebtoken dependency.
  const auth = typeof authMw === 'function' ? authMw : getAuthRequired();

  // adminGate runs AFTER authRequired has populated req.user. We compose
  // the two by calling authRequired first, then dispatching adminGate
  // only if authRequired called next() (i.e. req.user is set).
  function adminGate(req, res, next) {
    if (!req.user || !Number.isFinite(req.user.id)) {
      return res.status(401).json({ error: 'الجلسة غير صالحة.' });
    }
    Promise.resolve()
      .then(() => query('SELECT id, is_admin FROM users WHERE id = $1', [req.user.id]))
      .then((result) => {
        const row = result && result.rows && result.rows[0] ? result.rows[0] : null;
        if (!isUserAdminRow(row)) {
          return res.status(403).json({ error: 'مش مسموح لك تدخل لوحة التحكم.' });
        }
        // Mark req.user.isAdmin true so downstream handlers can branch
        // (e.g. archive replay's already-existing isAdmin path).
        req.user.isAdmin = true;
        return next();
      })
      .catch((err) => {
        // Never leak the DB error message to the client. Server-log a
        // short classification only.
        const code = err && err.code ? String(err.code) : 'unknown';
        console.warn('[admin] gate query failed:', code);
        return res.status(503).json({ error: 'تعذّر التحقق من الصلاحيات. حاول تاني.' });
      });
  }

  return function adminRequired(req, res, next) {
    auth(req, res, (err) => {
      if (err) return next(err);
      // If authRequired short-circuited with a 401, response already sent.
      if (res.headersSent) return;
      adminGate(req, res, next);
    });
  };
}

// Lazy default — production export. Tests should use createAdminRequired
// with an injected query.
let _defaultAdminMw = null;
function getDefaultAdminRequired() {
  if (_defaultAdminMw) return _defaultAdminMw;
  const { query } = require('../database');
  _defaultAdminMw = createAdminRequired({ query });
  return _defaultAdminMw;
}

function adminRequired(req, res, next) {
  return getDefaultAdminRequired()(req, res, next);
}

module.exports = {
  adminRequired,
  createAdminRequired,
  isUserAdminRow,
};
