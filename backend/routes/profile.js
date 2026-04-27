/**
 * Profile route — GET / PUT /api/profile/me.
 *
 * Validation, normalization, and DB-row mapping are pure helpers in
 * routes/profile-helpers.js so tests can exercise them without
 * installing express / jsonwebtoken / dotenv.
 */
const express = require('express');
const { query } = require('../database');
const { authRequired } = require('../middleware/auth');
const {
  validateAndNormalizeProfileInput,
  validateBioAiRequest,
  mapProfileRow,
  mapStatsRow,
  LIMITS,
} = require('./profile-helpers');
const ai = require('../services/ai');

const router = express.Router();

router.get('/me', authRequired, async (req, res, next) => {
  try {
    // Lazy-create the profile row so subsequent UPDATEs can rely on it.
    await query(
      `INSERT INTO user_profiles (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
      [req.user.id]
    );

    const [{ rows: profileRows }, { rows: statsRows }] = await Promise.all([
      query('SELECT * FROM user_profiles WHERE user_id = $1', [req.user.id]),
      query('SELECT * FROM user_stats    WHERE user_id = $1', [req.user.id]),
    ]);

    return res.json({
      user: {
        id: req.user.id,
        username: req.user.username,
        isGuest: req.user.isGuest,
      },
      profile: mapProfileRow(profileRows[0]) || mapProfileRow({}),
      stats: mapStatsRow(statsRows[0]),
    });
  } catch (err) {
    return next(err);
  }
});

router.put('/me', authRequired, async (req, res, next) => {
  const { ok, errors, normalized } = validateAndNormalizeProfileInput(req.body);
  if (!ok) {
    return res.status(400).json({ error: errors[0], errors });
  }
  try {
    // COALESCE on each column so absent fields leave existing values
    // untouched. Empty string for avatarUrl/bio overrides COALESCE
    // because '' is non-null — that's the documented "clear" path.
    await query(
      `INSERT INTO user_profiles
         (user_id, display_name, avatar_url, bio, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, user_profiles.display_name),
         avatar_url   = COALESCE(EXCLUDED.avatar_url,   user_profiles.avatar_url),
         bio          = COALESCE(EXCLUDED.bio,          user_profiles.bio),
         updated_at   = NOW()`,
      [req.user.id, normalized.displayName, normalized.avatarUrl, normalized.bio]
    );

    const { rows } = await query('SELECT * FROM user_profiles WHERE user_id = $1', [req.user.id]);
    return res.json({ profile: mapProfileRow(rows[0]) });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/profile/bio/ai — D5 AI bio writer.
 *
 * Body: { rawIdea: string }
 * Response: { bio, source }
 *
 * Generates a Mafiozo-noir bio suggestion. Does NOT persist anything —
 * the user accepts/rejects on the frontend, and saves through the
 * existing PUT /api/profile/me path.
 *
 * AI privacy: writeProfileBio uses C1 logAi metadata-only logging
 * (task=profile_bio). The rawIdea is NOT logged; the generated bio is
 * NOT logged. The AI provider chain is unchanged (Gemini Flash →
 * OpenRouter → deterministic fallback).
 */
router.post('/bio/ai', authRequired, async (req, res, next) => {
  const v = validateBioAiRequest(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const result = await ai.writeProfileBio({
      rawIdea: v.normalized.rawIdea,
      username: (req.user && req.user.username) || null,
    });
    if (!result || !result.bio) {
      // writeProfileBio always returns at least a fallback bio; this is
      // belt-and-suspenders.
      return res.status(503).json({ error: 'الكبير ما قدرش يكتب الآن. حاول تاني بعد لحظات.' });
    }
    return res.json({ bio: result.bio, source: result.source || 'fallback' });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
// Re-exported for convenience; canonical home is profile-helpers.js.
module.exports.validateAndNormalizeProfileInput = validateAndNormalizeProfileInput;
module.exports.validateBioAiRequest = validateBioAiRequest;
module.exports.mapProfileRow = mapProfileRow;
module.exports.mapStatsRow = mapStatsRow;
module.exports.LIMITS = LIMITS;
