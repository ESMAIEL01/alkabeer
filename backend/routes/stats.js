/**
 * Stats route — GET /api/stats/me.
 *
 * winRate is reported as an INTEGER percentage (0..100). gamesPlayed === 0
 * → 0. Logic lives in profile-helpers#mapStatsRow.
 */
const express = require('express');
const { query } = require('../database');
const { authRequired } = require('../middleware/auth');
const { mapStatsRow } = require('./profile-helpers');

const router = express.Router();

router.get('/me', authRequired, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM user_stats WHERE user_id = $1', [req.user.id]);
    return res.json({ stats: mapStatsRow(rows[0]) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
