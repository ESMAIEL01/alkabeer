/**
 * History route — GET /api/history/me.
 *
 * Per-user match history SUMMARY. Privacy gate: WHERE p.user_id = $caller.
 * Response intentionally OMITS archive_b64, final_reveal, voting_history,
 * and any other player's role data. Full archive replay (with those
 * sensitive fields) lands in D4 with its own participants gate.
 *
 * Pagination + row-mapping helpers live in routes/history-helpers.js so
 * tests can run without express installed locally.
 */
const express = require('express');
const { query } = require('../database');
const { authRequired } = require('../middleware/auth');
const { parsePagination, mapHistoryRow, LIMITS } = require('./history-helpers');

const router = express.Router();

router.get('/me', authRequired, async (req, res, next) => {
  const { limit, offset } = parsePagination(req.query);
  try {
    const [{ rows: gameRows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT
            s.id, s.scenario_title, s.host_mode, s.reveal_mode, s.outcome,
            s.ended_at, s.created_at,
            p.game_role, p.story_character_name, p.story_character_role,
            p.eliminated_at_round, p.was_winner
         FROM game_participants p
         JOIN game_sessions s ON s.id = p.game_id
         WHERE p.user_id = $1
         ORDER BY COALESCE(s.ended_at, s.created_at) DESC
         LIMIT $2 OFFSET $3`,
        [req.user.id, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
           FROM game_participants
          WHERE user_id = $1`,
        [req.user.id]
      ),
    ]);

    return res.json({
      games: gameRows.map(mapHistoryRow),
      total: (countRows[0] && countRows[0].total) || 0,
      limit,
      offset,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.parsePagination = parsePagination;
module.exports.mapHistoryRow = mapHistoryRow;
module.exports.LIMITS = LIMITS;
