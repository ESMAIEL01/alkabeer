/**
 * authRequired — JWT-bearer middleware for protected REST routes.
 *
 * Reuses the same token format issued by routes/auth.js
 * (signUserToken: { id, username, isGuest }) and the same secret
 * (config.jwtSecret). Attaches req.user with normalized fields:
 *   { id, username, isGuest, isAdmin }
 * (isAdmin defaults to false until F2 lands the admin column.)
 *
 * Hard guarantees:
 *   - Never prints the token.
 *   - Never echoes the JWT secret.
 *   - Returns Arabic 401 JSON on any failure path.
 */
const jwt = require('jsonwebtoken');
const config = require('../config/env');

function unauthorized(res, message) {
  return res.status(401).json({ error: message });
}

function authRequired(req, res, next) {
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

  req.user = {
    id: decoded.id,
    username: decoded.username || null,
    isGuest: !!decoded.isGuest,
    isAdmin: !!decoded.isAdmin,
  };
  return next();
}

module.exports = { authRequired };
