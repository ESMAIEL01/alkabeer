/**
 * Rate limiters for public endpoints.
 *
 * All limits use IP + route grouping. Behind Fly.io we set `trust proxy` in
 * server.js so `req.ip` is the real client IP (X-Forwarded-For).
 *
 * Tunable via env vars (see config/env.js):
 *   AUTH_RATE_WINDOW_MS / AUTH_RATE_MAX
 *   AI_RATE_WINDOW_MS   / AI_RATE_MAX
 */
const rateLimit = require('express-rate-limit');
const config = require('../config/env');

const arabicJson = (message) => ({
  handler: (_req, res) => res.status(429).json({ error: message }),
  standardHeaders: true,
  legacyHeaders: false,
});

// /api/auth/* — protect against credential stuffing and guest spam.
const authLimiter = rateLimit({
  windowMs: config.rateLimit.authWindowMs,
  max: config.rateLimit.authMax,
  ...arabicJson('محاولات كتير على بعض. هدّي شوية وارجع تاني.'),
});

// /api/scenarios/* — protect Gemini quota burn.
const aiLimiter = rateLimit({
  windowMs: config.rateLimit.aiWindowMs,
  max: config.rateLimit.aiMax,
  ...arabicJson('الكبير بيكتب لسه... استنى دقيقة وحاول تاني.'),
});

module.exports = { authLimiter, aiLimiter };
