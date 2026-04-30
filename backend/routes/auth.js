const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const config = require('../config/env');
const { query } = require('../database');
const { logEvent } = require('../services/analytics');

const router = express.Router();

// Fire-and-forget event helper. Never throws, never blocks the response.
function fireEvent(args) {
  try {
    Promise.resolve(logEvent(args)).catch(() => {});
  } catch { /* swallow */ }
}

const USERNAME_RE = /^[a-zA-Z0-9_؀-ۿ]{3,24}$/; // letters, digits, underscore, Arabic
const PASSWORD_MIN = 8;

function signUserToken(user, isGuest) {
  return jwt.sign(
    { id: user.id, username: user.username, isGuest },
    config.jwtSecret,
    { expiresIn: isGuest ? config.guestJwtExpiresIn : config.jwtExpiresIn }
  );
}

function publicUser(row, isGuest) {
  return { id: row.id, username: row.username, isGuest };
}

// ----- POST /api/auth/register --------------------------------------------
router.post('/register', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'الاسم والشفرة مطلوبين.' });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'الاسم لازم يكون من 3 لـ 24 حرف بالعربي أو الإنجليزي أو أرقام.' });
  }
  if (password.length < PASSWORD_MIN) {
    return res.status(400).json({ error: `الشفرة لازم تكون ${PASSWORD_MIN} حروف على الأقل.` });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `INSERT INTO users (username, password_hash, is_guest, status)
       VALUES ($1, $2, FALSE, 'pending')
       RETURNING id, username`,
      [username, hash]
    );
    const user = rows[0];
    fireEvent({ eventType: 'auth.user_registered', userId: user.id, payload: {} });
    return res.status(202).json({
      pending: true,
      message: 'حسابك اتسجّل وبينتظر موافقة الأدمن. هيتواصلوا معاك قريب.',
    });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'الاسم ده مستخدم قبل كده.' });
    }
    console.error('register error:', err);
    return res.status(500).json({ error: 'حصل خطأ غير متوقع. حاول تاني.' });
  }
});

// ----- POST /api/auth/login -----------------------------------------------
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'الاسم والشفرة مطلوبين.' });
  }

  try {
    const { rows } = await query(
      `SELECT id, username, password_hash, is_guest, status
       FROM users
       WHERE username = $1`,
      [username]
    );
    const row = rows[0];
    if (!row || row.is_guest || !row.password_hash) {
      return res.status(401).json({ error: 'بيانات الدخول غلط.' });
    }

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'بيانات الدخول غلط.' });
    }

    // Status checks after password verification to avoid timing oracle.
    if (row.status === 'pending') {
      return res.status(403).json({ error: 'حسابك لسه بينتظر موافقة الأدمن.', pending: true });
    }
    if (row.status === 'rejected') {
      return res.status(403).json({ error: 'الحساب ده مش مفعّل. تواصل مع الأدمن.' });
    }
    if (row.status === 'deleted') {
      return res.status(401).json({ error: 'بيانات الدخول غلط.' });
    }

    // Record login timestamp — fire-and-forget, never blocks the response.
    query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [row.id]).catch(() => {});

    const token = signUserToken(row, false);
    fireEvent({ eventType: 'auth.user_login', userId: row.id, payload: {} });
    return res.json({ token, user: publicUser(row, false) });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ error: 'حصل خطأ غير متوقع. حاول تاني.' });
  }
});

// ----- POST /api/auth/guest -----------------------------------------------
router.post('/guest', async (req, res) => {
  let baseName = (req.body && req.body.username || '').trim();
  if (baseName && !USERNAME_RE.test(baseName)) baseName = '';
  if (!baseName) {
    baseName = `Guest_${Math.floor(1000 + Math.random() * 9000)}`;
  } else {
    baseName = `${baseName}_(Guest)`;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = attempt === 0 ? baseName : `${baseName}_${Math.floor(1000 + Math.random() * 9000)}`;
    try {
      const { rows } = await query(
        `INSERT INTO users (username, password_hash, is_guest, status, expires_at)
         VALUES ($1, NULL, TRUE, 'approved', NOW() + INTERVAL '24 hours')
         RETURNING id, username`,
        [candidate]
      );
      const user = rows[0];
      const token = signUserToken(user, true);
      fireEvent({ eventType: 'auth.guest_created', userId: user.id, payload: {} });
      return res.json({ token, user: publicUser(user, true) });
    } catch (err) {
      if (err && err.code === '23505') {
        // Username collision — retry.
        continue;
      }
      console.error('guest error:', err);
      return res.status(500).json({ error: 'حصل خطأ غير متوقع. حاول تاني.' });
    }
  }
  return res.status(500).json({ error: 'تعذّر إنشاء جلسة الضيف.' });
});

// ----- GET /api/auth/me ---------------------------------------------------
// Lightweight token-verifying endpoint the frontend can use to bootstrap.
// F2: also resolves the user's current is_admin flag from the DB so admin
// demotion takes effect on the next /me call without requiring re-login.
// The flag is read from the live row, NOT from the JWT.
router.get('/me', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'غير مصرح.' });
  let decoded;
  try {
    decoded = jwt.verify(token, config.jwtSecret);
  } catch {
    return res.status(401).json({ error: 'الجلسة انتهت.' });
  }
  let isAdmin = false;
  try {
    const { rows } = await query(
      'SELECT is_admin FROM users WHERE id = $1',
      [decoded.id]
    );
    isAdmin = !!(rows && rows[0] && rows[0].is_admin === true);
  } catch (e) {
    // Non-fatal: a DB blip shouldn't strand a valid session. Default to
    // isAdmin=false (non-admins lose nothing; admins retry on next /me).
    console.warn('[auth/me] is_admin lookup failed:', e && e.message);
  }
  return res.json({
    user: {
      id: decoded.id,
      username: decoded.username,
      isGuest: !!decoded.isGuest,
      isAdmin,
    }
  });
});

module.exports = router;
