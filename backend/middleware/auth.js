/**
 * authRequired — JWT-bearer middleware for protected REST routes.
 *
 * Reuses the same token format issued by routes/auth.js and the same secret.
 * Attaches req.user: { id, username, isGuest, isAdmin }
 *
 * After JWT verification, performs one DB SELECT to enforce account status:
 *   - deleted  → 401
 *   - rejected → 403
 *   - pending  → 403
 *   - guest with expired expires_at → 401
 *
 * This ensures that revoking or soft-deleting an account takes effect on the
 * next request even if a valid JWT is still in circulation (7-day expiry).
 *
 * Hard guarantees:
 *   - Never prints the token.
 *   - Never echoes the JWT secret.
 *   - Returns Arabic 401/403 JSON on every failure path.
 */
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { query } = require('../database');

function unauthorized(res, message) {
  return res.status(401).json({ error: message });
}

function authRequired(req, res, next) {
  _authRequired(req, res, next).catch((err) => {
    console.error('[authRequired] unexpected error:', err && err.message);
    if (!res.headersSent) res.status(500).json({ error: 'حصل خطأ غير متوقع.' });
  });
}

async function _authRequired(req, res, next) {
  const auth = req.headers && req.headers.authorization
    ? String(req.headers.authorization)
    : '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return unauthorized(res, 'غير مصرح. لازم تسجّل دخولك الأول.');

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwtSecret);
  } catch {
    return unauthorized(res, 'الجلسة انتهت. سجّل دخولك من جديد.');
  }

  if (!decoded || !decoded.id) {
    return unauthorized(res, 'الجلسة غير صالحة.');
  }

  // Preliminary user object — isAdmin will be overwritten from DB below.
  req.user = {
    id: decoded.id,
    username: decoded.username || null,
    isGuest: !!decoded.isGuest,
    isAdmin: false, // never trust the JWT claim; DB is authoritative
  };

  // DB account status + admin check. Enforces approval flow and guest expiry
  // even when a JWT is technically still valid, and resolves live is_admin so
  // demotion takes effect immediately without requiring re-login.
  const { rows } = await query(
    'SELECT status, expires_at, is_guest, is_admin FROM users WHERE id = $1',
    [decoded.id]
  );
  const row = rows[0];
  if (!row) return unauthorized(res, 'الحساب مش موجود. سجّل دخولك من جديد.');
  if (row.status === 'deleted') return unauthorized(res, 'بيانات الدخول غلط.');
  if (row.status === 'rejected') return res.status(403).json({ error: 'الحساب ده مش مفعّل. تواصل مع الأدمن.' });
  if (row.status === 'pending') return res.status(403).json({ error: 'حسابك لسه بينتظر موافقة الأدمن.' });
  if (row.is_guest && row.expires_at && new Date(row.expires_at) < new Date()) {
    return unauthorized(res, 'جلسة الضيف انتهت. سجّل كحساب أو ابدأ جلسة ضيف جديدة.');
  }

  // Resolve live admin flag. Admin accounts must also pass the approved check
  // above, so a pending/rejected/deleted admin cannot reach this line.
  req.user.isAdmin = row.is_admin === true;

  return next();
}

module.exports = { authRequired };
