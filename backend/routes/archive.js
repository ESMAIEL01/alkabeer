/**
 * Archive replay route — GET /api/archive/:gameId.
 *
 * Returns a sanitized post-game replay for callers who participated in
 * the game (or who are admins, once F2 lands the column). Sensitive
 * fields are filtered before the response: archive_b64, host_user_id,
 * password, and JWT-related fields never appear in the payload. The
 * voting_history JSONB is reduced to an allow-list per round entry.
 *
 * Auth: requires a valid JWT.
 * Status codes:
 *   404 — game session not found
 *   403 — caller did not participate (and is not admin)
 *   200 — full sanitized replay
 */
const express = require('express');
const { query } = require('../database');
const { authRequired } = require('../middleware/auth');
const {
  canReadArchive,
  mapSessionRow,
  mapParticipantRow,
  buildCallerSummary,
  sanitizeVotingHistory,
} = require('./archive-helpers');

const router = express.Router();

router.get('/:gameId', authRequired, async (req, res, next) => {
  const gameId = req.params && req.params.gameId ? String(req.params.gameId) : null;
  if (!gameId) return res.status(404).json({ error: 'الأرشيف غير موجود.' });

  try {
    const { rows: sessionRows } = await query(
      `SELECT id, host_mode, reveal_mode, custom_config, outcome,
              scenario_title, voting_history, final_reveal,
              ended_at, created_at
         FROM game_sessions
         WHERE id = $1`,
      [gameId]
    );
    const session = sessionRows[0];
    if (!session) return res.status(404).json({ error: 'الأرشيف غير موجود.' });

    const { rows: participantRows } = await query(
      `SELECT user_id, username, was_host, game_role,
              story_character_name, story_character_role,
              eliminated_at_round, was_winner
         FROM game_participants
         WHERE game_id = $1
         ORDER BY was_host DESC, username ASC`,
      [gameId]
    );

    if (!canReadArchive(participantRows, req.user.id, req.user.isAdmin)) {
      return res.status(403).json({ error: 'مش مسموح لك تشوف الأرشيف ده.' });
    }

    const callerRow = participantRows.find(
      r => r && r.user_id !== null && r.user_id !== undefined
        && (r.user_id === req.user.id || String(r.user_id) === String(req.user.id))
    );

    return res.json({
      session: mapSessionRow(session),
      caller: buildCallerSummary(callerRow),
      participants: participantRows.map(mapParticipantRow).filter(Boolean),
      votingHistory: sanitizeVotingHistory(session.voting_history),
      // finalReveal is permitted in full only because phase === FINAL_REVEAL
      // for this archived game (it would not exist otherwise — gate already
      // applied during persistSessionAndStats). Frontend may render the
      // entire object as-is; it never contains archive_b64 or DB-internal
      // fields by virtue of how buildFinalReveal constructs it.
      finalReveal: session.final_reveal || null,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
// Re-exports for parity with profile.js / history.js patterns:
module.exports.canReadArchive = canReadArchive;
module.exports.mapSessionRow = mapSessionRow;
module.exports.mapParticipantRow = mapParticipantRow;
module.exports.sanitizeVotingHistory = sanitizeVotingHistory;
